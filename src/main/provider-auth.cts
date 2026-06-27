import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { codexBin } from "./app-server.cjs";

const execFileAsync = promisify(execFile);

// GUI apps don't inherit the shell PATH on macOS, so a bare `codex` spawn fails
// with ENOENT. Resolve to the bundled/vendored binary.
const CODEX = codexBin();

// CLI-backed auth for the providers that own their own login session:
// Codex (`codex login`) and Claude Code (`claude auth …`).
export type AuthProvider = "codex" | "claude" | "copilot";

export interface ProviderAuthStatus {
  codex: boolean;
  claude: boolean;
  copilot: boolean;
}

const COMMANDS: Record<AuthProvider, { status: [string, string[]]; login: [string, string[]]; logout: [string, string[]] }> = {
  codex: { status: [CODEX, ["login", "status"]], login: [CODEX, ["login"]], logout: [CODEX, ["logout"]] },
  claude: { status: ["claude", ["auth", "status"]], login: ["claude", ["auth", "login"]], logout: ["claude", ["auth", "logout"]] },
  copilot: { status: ["gh", ["auth", "status"]], login: ["gh", ["auth", "login", "--web"]], logout: ["gh", ["auth", "logout"]] },
};

async function loggedIn(cmd: string, args: string[]): Promise<boolean> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { timeout: 8000 });
    const out = `${stdout}${stderr}`.toLowerCase();
    if (/not logged in|logged out|no credentials|not authenticated|signed out|please run|로그인되지 않음/.test(out)) return false;
    return /logged in|authenticated|signed in|account|api key|로그인/.test(out);
  } catch {
    return false;
  }
}

async function copilotReady(): Promise<boolean> {
  // GitHub Copilot needs the Copilot CLI (a gh extension or standalone copilot),
  // not just a logged-in `gh`. Treat it as connected only when that responds.
  try {
    const { stdout, stderr } = await execFileAsync("gh", ["copilot", "--version"], { timeout: 8000 });
    return !/not installed|unknown command|no such/i.test(`${stdout}${stderr}`);
  } catch {
    return false;
  }
}

export async function providerAuthStatus(): Promise<ProviderAuthStatus> {
  const [codex, claude, copilot] = await Promise.all([
    loggedIn(...COMMANDS.codex.status),
    loggedIn(...COMMANDS.claude.status),
    copilotReady(),
  ]);
  return { codex, claude, copilot };
}

// Login flows are interactive (they open a browser / prompt), so detach and
// let the OS session handle them; the renderer re-checks status afterwards.
export function providerLogin(provider: AuthProvider): void {
  const [cmd, args] = COMMANDS[provider].login;
  const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
  child.unref();
}

export async function providerLogout(provider: AuthProvider): Promise<void> {
  const [cmd, args] = COMMANDS[provider].logout;
  await execFileAsync(cmd, args, { timeout: 8000 }).catch(() => undefined);
}
