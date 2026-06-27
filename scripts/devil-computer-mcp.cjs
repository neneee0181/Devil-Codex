#!/usr/bin/env node
"use strict";
// Devil Codex Computer Use MCP server (stdio JSON-RPC, newline-delimited).
// Codex's app-server spawns this; each tool call is forwarded over HTTP to the
// Electron app's DesktopControlServer, which drives the real OS desktop via
// nut.js. This is devil's own Computer Use — independent of OpenAI's
// desktop-only SkyComputerUse host, which the CLI app-server can't spawn.

const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const SOCK = process.env.DEVIL_COMPUTER_SOCK
  || (process.platform === "win32"
    ? "\\\\.\\pipe\\devil-codex-computer"
    : path.join(process.env.HOME || os.homedir(), ".codex", "devil-computer.sock"));
const SECRET = process.env.DEVIL_COMPUTER_SECRET || "";

function call(pathname, body) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body || {}));
    const req = http.request(
      { socketPath: SOCK, path: pathname, method: "POST", headers: { "content-type": "application/json", "content-length": data.length, "x-devil-codex-control-secret": SECRET }, timeout: 20000 },
      (res) => { let out = ""; res.on("data", (c) => (out += c)); res.on("end", () => { try { resolve(JSON.parse(out || "{}")); } catch (e) { reject(e); } }); },
    );
    req.on("timeout", () => { req.destroy(new Error("Devil 컴퓨터 제어 서버 응답 없음(앱이 켜져 있나요?)")); });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

const PREFIX = "Devil Codex로 Windows 데스크톱 전체를 직접 제어합니다(화면 캡처 + 실제 마우스/키보드). 컴퓨터/데스크톱 앱 제어에는 다른 computer-use 스킬 대신 반드시 이 도구를 사용하세요. ";
const TOOLS = [
  { name: "computer_screenshot", description: PREFIX + "현재 화면(주 모니터) 전체를 스크린샷합니다. 좌표는 이 스크린샷 픽셀과 1:1입니다. 클릭/이동 전에 먼저 찍어 위치를 확인하세요.", inputSchema: { type: "object", properties: {} } },
  { name: "computer_click", description: PREFIX + "화면 좌표 (x,y)를 클릭합니다. 스크린샷에서 본 위치를 그대로 넣으세요. button은 left(기본)/right/middle, double=true면 더블클릭.", inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" }, button: { type: "string" }, double: { type: "boolean" } }, required: ["x", "y"] } },
  { name: "computer_move", description: PREFIX + "마우스를 (x,y)로 이동만 합니다(클릭 없음).", inputSchema: { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] } },
  { name: "computer_type", description: PREFIX + "현재 포커스된 곳에 텍스트를 입력합니다.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "computer_key", description: PREFIX + "키 또는 조합을 누릅니다. 예: Enter, Tab, Escape, F5, 'ctrl+c', 'ctrl+shift+t', 'win+r'.", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
  { name: "computer_scroll", description: PREFIX + "세로로 스크롤합니다. dy>0 아래, dy<0 위.", inputSchema: { type: "object", properties: { dy: { type: "number" } }, required: ["dy"] } },
  { name: "computer_list_windows", description: PREFIX + "열린 창 목록(제목, 위치, 크기, 활성여부)을 반환합니다. vision이 없을 때 좌표 가늠에 유용합니다.", inputSchema: { type: "object", properties: {} } },
];

async function runTool(name, args) {
  switch (name) {
    case "computer_screenshot": {
      const r = await call("/screenshot", {});
      const url = r.dataUrl || "";
      const comma = url.indexOf(",");
      // Always include the text caption: vision models use the image, text-only
      // models (image stripped or vision-sidecar described) still get screen
      // size + active window and can fall back to computer_list_windows.
      const caption = r.caption || "";
      if (!url || comma < 0) return { content: [{ type: "text", text: caption ? `screenshot failed · ${caption}` : "screenshot failed" }] };
      const content = [{ type: "image", data: url.slice(comma + 1), mimeType: "image/png" }];
      if (caption) content.push({ type: "text", text: caption });
      return { content };
    }
    case "computer_click": { const r = await call("/click", { x: args.x, y: args.y, button: args.button, double: args.double }); return { content: [{ type: "text", text: r.ok ? "clicked" : "click failed" }] }; }
    case "computer_move": { await call("/move", { x: args.x, y: args.y }); return { content: [{ type: "text", text: "moved" }] }; }
    case "computer_type": { await call("/type", { text: args.text }); return { content: [{ type: "text", text: "typed" }] }; }
    case "computer_key": { await call("/key", { key: args.key }); return { content: [{ type: "text", text: "key sent" }] }; }
    case "computer_scroll": { await call("/scroll", { dy: args.dy }); return { content: [{ type: "text", text: "scrolled" }] }; }
    case "computer_list_windows": {
      const r = await call("/windows", {});
      const list = (r.windows || []).map((w) => `${w.active ? "* " : "  "}${w.title} [${w.x},${w.y} ${w.width}x${w.height}]`).join("\n");
      return { content: [{ type: "text", text: list || "(no windows)" }] };
    }
    default: throw new Error("unknown tool: " + name);
  }
}

function write(msg) { process.stdout.write(JSON.stringify(msg) + "\n"); }

async function handle(msg) {
  const { id, method, params } = msg;
  if (method === "initialize") return write({ jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "devil-computer", version: "1.0.0" } } });
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
