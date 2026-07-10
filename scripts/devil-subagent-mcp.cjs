#!/usr/bin/env node
"use strict";

const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const SOCK = process.env.DEVIL_SUBAGENT_SOCK
  || (process.platform === "win32"
    ? "\\\\.\\pipe\\devil-codex-subagent"
    : path.join(process.env.HOME || os.homedir(), ".codex", "devil-subagent.sock"));
const SECRET = process.env.DEVIL_SUBAGENT_SECRET || "";

function call(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const req = http.request(
      { socketPath: SOCK, path: pathname, method: "POST", headers: { "content-type": "application/json", "content-length": data.length, "x-devil-codex-control-secret": SECRET }, timeout: Math.max(30_000, Math.min(Number(body && body.timeoutMs) || 300_000, 900_000)) + 15_000 },
      (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => {
          try { resolve(JSON.parse(out || "{}")); }
          catch (e) { reject(e); }
        });
      },
    );
    req.on("timeout", () => { req.destroy(new Error("Devil 하위 에이전트 서버 응답 없음(앱이 켜져 있나요?)")); });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

const DESC = [
  "Devil Codex 내부 Provider를 별도 하위 에이전트처럼 호출해 제한된 작업을 위임합니다.",
  "DeepSeek/OpenRouter/Claude Code/Copilot 등 Devil에 등록된 provider/model을 명시할 수 있습니다.",
  "",
  "권장 사용:",
  "- 긴 코드 조사, 독립 리뷰, 대안 설계처럼 메인 컨텍스트를 아끼고 싶은 작업.",
  "- provider/model이 명확할 때. 예: provider='deepseek', model='deepseek-reasoner'.",
  "",
  "주의:",
  "- task에는 필요한 파일 경로, 관찰 내용, 원하는 출력 형식을 구체적으로 넣으세요.",
  "- 별도 모델 호출이므로 해당 provider 사용량/비용이 발생할 수 있습니다.",
  "- 결과는 요약 텍스트로 반환됩니다. 사용자가 요청하지 않은 대규모 파일 변경은 직접 수행하지 마세요.",
  "- 하위 에이전트는 Devil Codex의 현재 승인 정책과 샌드박스를 따릅니다.",
].join("\n");

const TOOLS = [
  {
    name: "delegate_subagent",
    description: DESC,
    inputSchema: {
      type: "object",
      properties: {
        task: { type: "string", description: "하위 에이전트에게 맡길 구체적인 작업. 필요한 파일/맥락/출력 형식을 포함." },
        cwd: { type: "string", description: "작업 디렉터리. 생략하면 Devil Codex 기본 작업 디렉터리를 사용." },
        provider: { type: "string", description: "예: deepseek, openrouter, claude-code, copilot, antigravity. 생략하면 Devil의 현재 선택 provider." },
        accountId: { type: "string", description: "provider 계정 ID. 생략하면 해당 provider 기본 계정." },
        model: { type: "string", description: "예: deepseek-reasoner, deepseek-v4-pro. 생략하면 Devil의 현재 선택 모델." },
        runtime: { type: "string", enum: ["codex", "claude-code"], description: "실행 runtime. 일반 외부 provider는 codex, Claude Code native는 claude-code." },
        reasoningEffort: { type: "string", enum: ["low", "medium", "high", "xhigh"], description: "추론 강도. 생략하면 Devil Codex 기본 설정을 사용." },
        timeoutMs: { type: "number", description: "최대 대기 시간(ms). 기본 300000, 최대 900000." },
      },
      required: ["task"],
    },
  },
];

async function runTool(name, args) {
  if (name !== "delegate_subagent") throw new Error("unknown tool: " + name);
  const r = await call("/delegate", args || {});
  if (r.error) throw new Error(r.error);
  const header = [
    `taskId: ${r.taskId || "(unknown)"}`,
    `threadId: ${r.threadId || "(unknown)"}`,
    `status: ${r.status || "(unknown)"}`,
    r.provider ? `provider: ${r.provider}` : "",
    r.model ? `model: ${r.model}` : "",
  ].filter(Boolean).join("\n");
  const body = r.status === "completed" ? (r.result || "(empty result)") : (r.error || r.status || "failed");
  return { content: [{ type: "text", text: `${header}\n\n${body}` }], isError: r.status !== "completed" };
}

function write(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") return write({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "devil-subagent", version: "1.0.0" } } });
  if (method === "notifications/initialized" || method === "notifications/cancelled") return;
  if (method === "tools/list") return write({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  if (method === "tools/call") {
    try { const result = await runTool(params.name, params.arguments || {}); write({ jsonrpc: "2.0", id, result }); }
    catch (e) { write({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "error: " + (e && e.message ? e.message : String(e)) }], isError: true } }); }
    return;
  }
  if (id !== undefined) write({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    try { void handle(JSON.parse(line)); } catch { /* ignore malformed */ }
  }
});
