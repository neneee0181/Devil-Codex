#!/usr/bin/env node
"use strict";
// Devil Codex "ask the user" MCP server (stdio JSON-RPC, newline-delimited).
// Codex's app-server spawns this; the single tool forwards a structured question
// over HTTP to the Electron app's AskControlServer, which shows a modal and
// blocks until the user answers. Lets ANY model (Codex or external-via-proxy)
// pause and ask the user a multiple-choice question — like Claude Code's
// built-in AskUserQuestion, delivered here as an MCP tool.

const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const SOCK = process.env.DEVIL_ASK_SOCK
  || (process.platform === "win32"
    ? "\\\\.\\pipe\\devil-codex-ask"
    : path.join(process.env.HOME || os.homedir(), ".codex", "devil-ask.sock"));
const SECRET = process.env.DEVIL_ASK_SECRET || "";

function call(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const req = http.request(
      // Long timeout: the user may take a while to answer the modal.
      { socketPath: SOCK, path: pathname, method: "POST", headers: { "content-type": "application/json", "content-length": data.length, "x-devil-codex-control-secret": SECRET }, timeout: 1_500_000 },
      (res) => { let out = ""; res.on("data", (c) => (out += c)); res.on("end", () => { try { resolve(JSON.parse(out || "{}")); } catch (e) { reject(e); } }); },
    );
    req.on("timeout", () => { req.destroy(new Error("Devil 질문 서버 응답 없음(앱이 켜져 있나요?)")); });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// Guidance distilled from Claude Code's AskUserQuestion behaviour + its public
// docs/skill, so the driving model (Codex or external) produces high-quality,
// Claude-like clarifying questions instead of vague ones.
const DESC = [
  "여러 갈래의 정답이 가능하고 사용자만 결정할 수 있는 갈림길일 때, 진행을 멈추고 객관식으로 묻습니다(예: DB 선택, 인증 방식, 배포 대상).",
  "",
  "■ 쓸 때 / 안 쓸 때",
  "- 쓴다: 선택지가 명확히 갈리고, 고른 답에 따라 작업 방향/설정이 달라질 때.",
  "- 안 쓴다: 관례적 기본값이 있거나 코드·맥락으로 추론 가능할 때(그냥 진행). 자유서술이 필요하면(특정 선택지로 못 좁힘) 그냥 텍스트로 물어라. '계획 다 됐나요?' 같은 메타질문 금지.",
  "",
  "■ 좋은 질문 규칙",
  "- 한 호출에 질문 1~4개. 꼭 필요한 것만(보통 1~2개). 서로 무관한 질문을 한꺼번에 몰아넣지 말 것.",
  "- 질문은 구체적으로: '어떤 DB?'보다 '이 프로젝트에 어떤 DB를 쓸까요?'.",
  "- header는 ≤12자 짧은 명사 라벨(예: '인증 방식', '라이브러리').",
  "- 각 질문 선택지 2~4개. label은 1~5단어로 간결, description은 1~2문장으로 trade-off/영향을 설명.",
  "- 선택지는 서로 배타적이게(multiSelect=true일 때만 겹쳐도 됨).",
  "- 추천이 있으면 그 선택지를 맨 앞에 두고 label 끝에 '(추천)'을 붙여라.",
  "- multiSelect=true는 독립적으로 여러 개를 켤 수 있을 때만(예: 활성화할 기능들).",
  "- '기타/직접 입력' 선택지는 만들지 마라 — UI가 자동으로 자유 입력 칸을 제공한다.",
  "",
  "■ 묻기 전 자가점검(하나라도 '예'면 묻지 말고 진행)",
  "1) 합리적인 기본값이 있나? 2) 코드·파일·맥락으로 추론 가능한가? 3) 답이 바뀌어도 결과가 거의 같은가?",
  "→ 가정으로 진행할 땐 무엇을 가정했는지 한 줄로 남겨라. 단순 가정 확인용 질문은 하지 마라.",
  "여러 애매함이 있으면, '답이 작업을 가장 크게 바꾸는' 한 가지만 골라 물어라(정보이득 최대).",
  "",
  "■ 예시(좋은 호출)",
  '{"questions":[{"question":"인증을 어떻게 구현할까요?","header":"인증 방식",',
  '"options":[{"label":"NextAuth (추천)","description":"OAuth 다수 + 세션 관리 내장, 설정 빠름"},',
  '{"label":"Clerk","description":"호스티드 UI·관리 콘솔, 유료 한도 있음"},',
  '{"label":"직접 JWT","description":"완전한 제어, 보일러플레이트와 보안 책임 증가"}],"multiSelect":false}]}',
].join("\n");

const TOOLS = [
  {
    name: "ask_user",
    description: DESC,
    inputSchema: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          description: "1~4개의 질문. 꼭 필요한 것만(보통 1~2개).",
          items: {
            type: "object",
            properties: {
              question: { type: "string", description: "질문 본문. 구체적으로 작성." },
              header: { type: "string", description: "≤12자 짧은 명사 라벨(예: '인증 방식')." },
              multiSelect: { type: "boolean", description: "독립적으로 여러 개 선택 허용 시 true. 기본 false." },
              options: {
                type: "array",
                minItems: 2,
                maxItems: 4,
                description: "서로 배타적인 선택지 2~4개. 추천이 있으면 맨 앞 + label에 '(추천)'.",
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string", description: "선택지 표시 텍스트(1~5단어, 간결)." },
                    description: { type: "string", description: "선택지 설명(1~2문장, trade-off/영향)." },
                  },
                  required: ["label"],
                },
              },
            },
            required: ["question", "options"],
          },
        },
      },
      required: ["questions"],
    },
  },
];

async function runTool(name, args) {
  if (name !== "ask_user") throw new Error("unknown tool: " + name);
  const r = await call("/ask", { questions: args.questions || [] });
  if (r.cancelled || !Array.isArray(r.answers)) {
    return { content: [{ type: "text", text: "사용자가 답하지 않고 닫았습니다(취소). 합리적인 기본값으로 진행하거나 다르게 물어보세요." }] };
  }
  const lines = r.answers.map((a) => `Q: ${a.question}\nA: ${(a.answers || []).join(", ") || "(무응답)"}`);
  return { content: [{ type: "text", text: lines.join("\n\n") || "(응답 없음)" }] };
}

function write(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") return write({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "devil-ask", version: "1.0.0" } } });
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
