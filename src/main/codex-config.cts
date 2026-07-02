import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { codexHome } from "./codex-home.cjs";
import { preserveDesktopAppearanceTheme, recoverDesktopAppearanceTheme } from "./codex-desktop-theme.cjs";
import { writeCodexConfigAtomic } from "./codex-settings.cjs";

// Registers a local proxy as a NON-default Codex model provider so external
// models (Claude/Copilot) can run through the Codex app-server (tools + sync)
// while Codex-login models keep using the default provider untouched.

const CODEX_HOME = codexHome();
const CONFIG_PATH = join(CODEX_HOME, "config.toml");
export const DEVIL_PROVIDER = "devil";
const BEGIN = "# >>> devil-codex provider (managed) >>>";
const END = "# <<< devil-codex provider (managed) <<<";

function stripCommentLine(source: string, marker: string): string {
  return source.replace(new RegExp(`^\\s*${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(?:\\r?\\n)?`, "m"), "");
}

function stripTable(source: string, header: string): string {
  const escaped = header.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Match the table header line plus every following line up to (but not
  // including) the next table header, or end of file. Global so duplicate
  // tables are all removed. NOTE: JS regex has no \Z — the old pattern used it
  // as a lookahead alternative, which silently matched the literal "Z" instead
  // of end-of-input, so a table that was the LAST one in the file was never
  // stripped. registerDevil* appends its block last, so on the next launch the
  // old block survived and a duplicate was appended → "config.toml: duplicate
  // key" and a dead app-server (skills/list etc. all fail).
  const pattern = new RegExp(`^[ \\t]*\\[${escaped}\\][^\\n]*\\n(?:(?![ \\t]*\\[)[^\\n]*\\n?)*`, "gm");
  return source.replace(pattern, "");
}

function normalizeSpacing(source: string): string {
  return source.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function stripProviderBlock(source: string): string {
  return normalizeSpacing(stripCommentLine(stripCommentLine(stripTable(source, "model_providers.devil"), BEGIN), END));
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

// Atomic (temp+rename) and no-op when nothing changed: stock Codex and the
// bundled app-server read this file concurrently, and a truncated mid-write
// read makes them re-serialize a broken parse — silently dropping the user's
// model/theme/speed settings. Skipping unchanged writes also shrinks the
// number of race windows to near zero across Devil start/quit cycles.
async function writeConfigIfChanged(next: string, previous: string): Promise<void> {
  if (next === previous) return;
  await writeCodexConfigAtomic(CONFIG_PATH, next);
}

// Append the managed provider block at end of config (a TOML table can live
// anywhere). Root keys must already precede the first table; Codex writes them
// first, so appending our table last is safe.
export async function registerDevilProvider(port: number, secret = ""): Promise<void> {
  const source = await recoverDesktopAppearanceTheme(await read(), CODEX_HOME);
  await backupOnce(source);
  const cleaned = stripProviderBlock(source).trimEnd();
  const next = preserveDesktopAppearanceTheme(`${cleaned ? cleaned + "\n\n" : ""}${block(port, secret)}`, source);
  await writeConfigIfChanged(next, source);
}

export async function unregisterDevilProvider(): Promise<void> {
  const source = await recoverDesktopAppearanceTheme(await read(), CODEX_HOME);
  if (!source.includes(BEGIN)) return;
  await writeConfigIfChanged(preserveDesktopAppearanceTheme(stripProviderBlock(source), source), source);
}

// Register the embedded-browser MCP so Codex (and external models via the proxy)
// can drive Devil Codex's own in-app browser. Codex spawns the stdio script with
// Electron-as-node; it forwards tool calls to the local BrowserControlServer.
const MCP_BEGIN = "# >>> devil-codex browser mcp (managed) >>>";
const MCP_END = "# <<< devil-codex browser mcp (managed) <<<";

function stripManagedMcpTables(source: string, begin: string, end: string, names: string[]): string {
  let next = source;
  for (const name of names) {
    next = stripTable(next, `mcp_servers.${name}`);
    next = stripTable(next, `mcp_servers.${name}.env`);
  }
  next = stripCommentLine(next, begin);
  next = stripCommentLine(next, end);
  return normalizeSpacing(next);
}

function toml(value: string): string { return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`; }

export async function registerDevilBrowserMcp(input: { execPath: string; script: string; sock: string; secret: string; computerScript?: string; computerSock?: string; computerSecret?: string }): Promise<void> {
  const source = await recoverDesktopAppearanceTheme(await read(), CODEX_HOME);
  const cleaned = stripManagedMcpTables(source, MCP_BEGIN, MCP_END, ["devil_browser", "devil_computer"]).trimEnd();
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
  const next = preserveDesktopAppearanceTheme(`${cleaned ? cleaned + "\n\n" : ""}${block}`, source);
  await writeConfigIfChanged(next, source);
}

export async function unregisterDevilBrowserMcp(): Promise<void> {
  const source = await recoverDesktopAppearanceTheme(await read(), CODEX_HOME);
  if (!source.includes(MCP_BEGIN)) return;
  await writeConfigIfChanged(preserveDesktopAppearanceTheme(stripManagedMcpTables(source, MCP_BEGIN, MCP_END, ["devil_browser", "devil_computer"]), source), source);
}

// "Ask the user" MCP — a structured multiple-choice prompt (like Claude Code's
// built-in AskUserQuestion). Kept in its own managed block, registered at app
// start regardless of the Devil MCP toggle, so any model can always pause and
// ask the user. Tool calls bridge to AskControlServer → renderer modal.
const ASK_BEGIN = "# >>> devil-codex ask mcp (managed) >>>";
const ASK_END = "# <<< devil-codex ask mcp (managed) <<<";

export async function registerDevilAskMcp(input: { execPath: string; script: string; sock: string; secret: string }): Promise<void> {
  const source = await recoverDesktopAppearanceTheme(await read(), CODEX_HOME);
  const cleaned = stripManagedMcpTables(source, ASK_BEGIN, ASK_END, ["devil_ask"]).trimEnd();
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
  const next = preserveDesktopAppearanceTheme(`${cleaned ? cleaned + "\n\n" : ""}${block}`, source);
  await writeConfigIfChanged(next, source);
}

export async function unregisterDevilAskMcp(): Promise<void> {
  const source = await recoverDesktopAppearanceTheme(await read(), CODEX_HOME);
  if (!source.includes(ASK_BEGIN)) return;
  await writeConfigIfChanged(preserveDesktopAppearanceTheme(stripManagedMcpTables(source, ASK_BEGIN, ASK_END, ["devil_ask"]), source), source);
}
