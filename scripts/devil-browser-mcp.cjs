#!/usr/bin/env node
"use strict";
// Devil Codex embedded-browser MCP server (stdio JSON-RPC, newline-delimited).
// Codex's app-server spawns this; each tool call is forwarded over HTTP to the
// Electron app's BrowserControlServer, which drives the in-app <webview>. This
// lets any model (Codex or external-via-proxy) control our own browser — with
// the visible AI cursor — instead of Codex's unavailable in-app/Chrome backend.

const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
// Unix socket / Windows named pipe (Codex's sandbox blocks localhost TCP). Lives
// in ~/.codex so the sandboxed MCP can reach it.
const SOCK = process.env.DEVIL_BROWSER_SOCK
  || (process.platform === "win32"
    ? "\\\\.\\pipe\\devil-codex-browser"
    : path.join(process.env.HOME || os.homedir(), ".codex", "devil-browser.sock"));
const SECRET = process.env.DEVIL_BROWSER_SECRET || "";

function call(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const req = http.request(
      { socketPath: SOCK, path: pathname, method: "POST", headers: { "content-type": "application/json", "content-length": data.length, "x-devil-codex-control-secret": SECRET }, timeout: 15000 },
      (res) => { let out = ""; res.on("data", (c) => (out += c)); res.on("end", () => { try { resolve(JSON.parse(out || "{}")); } catch (e) { reject(e); } }); },
    );
    req.on("timeout", () => { req.destroy(new Error("Devil 브라우저 제어 서버 응답 없음(앱이 켜져 있나요?)")); });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// Strong guidance so the model uses THESE tools directly and does not fall back
// to Codex's built-in in-app/Chrome browser skills (which aren't available here).
// Escalation guidance mirrors devil-computer-mcp: native confirm()/alert()
// dialogs live outside the DOM, so selector clicks can never dismiss them -
// the model should route around them (script/API) instead of retrying.
const PREFIX = "Devil Codex 내장 브라우저를 직접 제어합니다. 브라우저 작업에는 다른 browser/in-app/Chrome 스킬 대신 반드시 이 도구를 사용하세요. 요소 클릭은 CSS selector가 좌표보다 정확합니다. native confirm()/alert() 다이얼로그는 DOM 밖이라 이 도구로 못 누릅니다 - 그 흐름은 스크립트/API 직접 호출로 우회하세요. ";
const TOOLS = [
  { name: "browser_navigate", description: PREFIX + "주어진 URL을 내장 브라우저에서 엽니다.", inputSchema: { type: "object", properties: { url: { type: "string" } }, required: ["url"] } },
  { name: "browser_read", description: PREFIX + "현재 페이지의 보이는 텍스트를 읽습니다.", inputSchema: { type: "object", properties: {} } },
  { name: "browser_screenshot", description: PREFIX + "현재 페이지를 스크린샷합니다.", inputSchema: { type: "object", properties: {} } },
  { name: "browser_click", description: PREFIX + "요소를 클릭합니다. 정확도를 위해 browser_read가 알려준 CSS selector를 우선 사용하세요(예: input#query). 좌표 x,y는 selector를 모를 때만 쓰고, 스크린샷에서 본 위치 그대로 넣으면 됩니다(스크린샷은 실제 좌표와 1:1). AI 커서가 보입니다.", inputSchema: { type: "object", properties: { selector: { type: "string" }, x: { type: "number" }, y: { type: "number" } } } },
  { name: "browser_type", description: PREFIX + "포커스된 요소에 텍스트를 입력합니다.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "browser_key", description: PREFIX + "키를 누릅니다(예: Enter, Tab).", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
  { name: "browser_scroll", description: PREFIX + "페이지를 세로로 dy 픽셀 스크롤합니다.", inputSchema: { type: "object", properties: { dy: { type: "number" } }, required: ["dy"] } },
];

async function runTool(name, args) {
  switch (name) {
    case "browser_navigate": { const s = await call("/navigate", { url: args.url }); return { content: [{ type: "text", text: `열림: ${s.title || "(제목 없음)"} — ${s.url || args.url}` }] }; }
    case "browser_read": { const r = await call("/read", {}); return { content: [{ type: "text", text: r.text || "(empty)" }] }; }
    case "browser_screenshot": {
      const r = await call("/screenshot", {});
      const url = r.dataUrl || "";
      const comma = url.indexOf(",");
      if (!url || comma < 0) return { content: [{ type: "text", text: "screenshot failed" }] };
      return { content: [{ type: "image", data: url.slice(comma + 1), mimeType: "image/png" }] };
    }
    case "browser_click": { const r = await call("/click", { selector: args.selector, x: args.x, y: args.y }); return { content: [{ type: "text", text: r.ok ? "clicked" : "target not found" }] }; }
    case "browser_type": { await call("/type", { text: args.text }); return { content: [{ type: "text", text: "typed" }] }; }
    case "browser_key": { await call("/key", { key: args.key }); return { content: [{ type: "text", text: "key sent" }] }; }
    case "browser_scroll": { await call("/scroll", { dy: args.dy }); return { content: [{ type: "text", text: "scrolled" }] }; }
    default: throw new Error("unknown tool: " + name);
  }
}

function write(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") return write({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "devil-browser", version: "1.0.0" } } });
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
