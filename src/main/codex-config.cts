import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Registers a local proxy as a NON-default Codex model provider so external
// models (Claude/Copilot) can run through the Codex app-server (tools + sync)
// while Codex-login models keep using the default provider untouched.

const CODEX_HOME = process.env.DEVIL_CODEX_CODEX_HOME ?? join(homedir(), ".codex");
const CONFIG_PATH = join(CODEX_HOME, "config.toml");
export const DEVIL_PROVIDER = "devil";
const BEGIN = "# >>> devil-codex provider (managed) >>>";
const END = "# <<< devil-codex provider (managed) <<<";

function stripBlock(source: string): string {
  const begin = source.indexOf(BEGIN);
  if (begin < 0) return source;
  const end = source.indexOf(END, begin);
  if (end < 0) return source.slice(0, begin).trimEnd() + "\n";
  return (source.slice(0, begin) + source.slice(end + END.length)).replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function block(port: number, secret: string): string {
  // The secret path segment gates the localhost proxy: only requests under
  // /<secret>/v1 are served, so a process/page that can't read this config
  // (perms 0600) can't drive the user's provider keys.
  const path = secret ? `/${secret}/v1` : "/v1";
  return [
    BEGIN,
    `[model_providers.${DEVIL_PROVIDER}]`,
    `name = "devil-codex"`,
    `base_url = "http://127.0.0.1:${port}${path}"`,
    `wire_api = "responses"`,
    // Native Codex passthrough relays the caller's ChatGPT OAuth headers when
    // compatibility mode makes Devil the active model provider.
    `requires_openai_auth = true`,
    END,
    "",
  ].join("\n");
}

async function backupOnce(source: string): Promise<void> {
  const dir = join(CODEX_HOME, "devil-codex-backups");
  await mkdir(dir, { recursive: true });
  const target = join(dir, `config-${new Date().toISOString().replace(/[:.]/g, "-")}.toml`);
  if (!existsSync(target)) await writeFile(target, source, { mode: 0o600 });
}

async function read(): Promise<string> {
  try { return await readFile(CONFIG_PATH, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
}

// Append the managed provider block at end of config (a TOML table can live
// anywhere). Root keys must already precede the first table; Codex writes them
// first, so appending our table last is safe.
export async function registerDevilProvider(port: number, secret = ""): Promise<void> {
  const source = await read();
  await backupOnce(source);
  const cleaned = stripBlock(source).trimEnd();
  const next = `${cleaned ? cleaned + "\n\n" : ""}${block(port, secret)}`;
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, next, { encoding: "utf8", mode: 0o600 });
}

export async function unregisterDevilProvider(): Promise<void> {
  const source = await read();
  if (!source.includes(BEGIN)) return;
  await writeFile(CONFIG_PATH, stripBlock(source), { encoding: "utf8", mode: 0o600 });
}

// Register the embedded-browser MCP so Codex (and external models via the proxy)
// can drive Devil Codex's own in-app browser. Codex spawns the stdio script with
// Electron-as-node; it forwards tool calls to the local BrowserControlServer.
const MCP_BEGIN = "# >>> devil-codex browser mcp (managed) >>>";
const MCP_END = "# <<< devil-codex browser mcp (managed) <<<";

function stripNamed(source: string, begin: string, end: string): string {
  const b = source.indexOf(begin);
  if (b < 0) return source;
  const e = source.indexOf(end, b);
  if (e < 0) return source.slice(0, b).trimEnd() + "\n";
  return (source.slice(0, b) + source.slice(e + end.length)).replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function toml(value: string): string { return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`; }

export async function registerDevilBrowserMcp(input: { execPath: string; script: string; sock: string; secret: string; computerScript?: string; computerSock?: string; computerSecret?: string }): Promise<void> {
  const source = await read();
  const cleaned = stripNamed(source, MCP_BEGIN, MCP_END).trimEnd();
  const lines = [
    MCP_BEGIN,
    `[mcp_servers.devil_browser]`,
    `command = ${toml(input.execPath)}`,
    `args = [${toml(input.script)}]`,
    // Electron-as-node is slow to boot; give the handshake room.
    `startup_timeout_sec = 60`,
    `tool_timeout_sec = 60`,
    `[mcp_servers.devil_browser.env]`,
    `ELECTRON_RUN_AS_NODE = "1"`,
    `DEVIL_BROWSER_SOCK = ${toml(input.sock)}`,
    `DEVIL_BROWSER_SECRET = ${toml(input.secret)}`,
  ];
  // devil-native Computer Use MCP (whole-desktop control via nut.js). Registered
  // alongside the browser MCP in the same managed block so both are cleaned
  // together. Tool calls bridge to DesktopControlServer over the named pipe.
  if (input.computerScript && input.computerSock) {
    lines.push(
      `[mcp_servers.devil_computer]`,
      `command = ${toml(input.execPath)}`,
      `args = [${toml(input.computerScript)}]`,
      `startup_timeout_sec = 60`,
      `tool_timeout_sec = 60`,
      `[mcp_servers.devil_computer.env]`,
      `ELECTRON_RUN_AS_NODE = "1"`,
      `DEVIL_COMPUTER_SOCK = ${toml(input.computerSock)}`,
      `DEVIL_COMPUTER_SECRET = ${toml(input.computerSecret ?? "")}`,
    );
  }
  lines.push(MCP_END, "");
  const block = lines.join("\n");
  const next = `${cleaned ? cleaned + "\n\n" : ""}${block}`;
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, next, { encoding: "utf8", mode: 0o600 });
}

export async function unregisterDevilBrowserMcp(): Promise<void> {
  const source = await read();
  if (!source.includes(MCP_BEGIN)) return;
  await writeFile(CONFIG_PATH, stripNamed(source, MCP_BEGIN, MCP_END), { encoding: "utf8", mode: 0o600 });
}

// "Ask the user" MCP — a structured multiple-choice prompt (like Claude Code's
// built-in AskUserQuestion). Kept in its own managed block, registered at app
// start regardless of the Devil MCP toggle, so any model can always pause and
// ask the user. Tool calls bridge to AskControlServer → renderer modal.
const ASK_BEGIN = "# >>> devil-codex ask mcp (managed) >>>";
const ASK_END = "# <<< devil-codex ask mcp (managed) <<<";

export async function registerDevilAskMcp(input: { execPath: string; script: string; sock: string; secret: string }): Promise<void> {
  const source = await read();
  const cleaned = stripNamed(source, ASK_BEGIN, ASK_END).trimEnd();
  const block = [
    ASK_BEGIN,
    `[mcp_servers.devil_ask]`,
    `command = ${toml(input.execPath)}`,
    `args = [${toml(input.script)}]`,
    `startup_timeout_sec = 60`,
    // The tool blocks on a human, so allow a long answer window.
    `tool_timeout_sec = 1500`,
    `[mcp_servers.devil_ask.env]`,
    `ELECTRON_RUN_AS_NODE = "1"`,
    `DEVIL_ASK_SOCK = ${toml(input.sock)}`,
    `DEVIL_ASK_SECRET = ${toml(input.secret)}`,
    ASK_END,
    "",
  ].join("\n");
  const next = `${cleaned ? cleaned + "\n\n" : ""}${block}`;
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, next, { encoding: "utf8", mode: 0o600 });
}

export async function unregisterDevilAskMcp(): Promise<void> {
  const source = await read();
  if (!source.includes(ASK_BEGIN)) return;
  await writeFile(CONFIG_PATH, stripNamed(source, ASK_BEGIN, ASK_END), { encoding: "utf8", mode: 0o600 });
}
