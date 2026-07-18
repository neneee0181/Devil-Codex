import { execFile } from "node:child_process";
import { mkdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { writeTextFileAtomic } from "./atomic-file.cjs";

const execFileAsync = promisify(execFile);
export const STOCK_PROXY_TASK_NAME = "Devil Codex Stock Bridge";
export const STOCK_PROXY_LAUNCH_AGENT_LABEL = "dev.devilcodex.stock-bridge";

function xmlString(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function stockProxyLaunchAgentPath(home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${STOCK_PROXY_LAUNCH_AGENT_LABEL}.plist`);
}

export function stockProxyLogPath(home = homedir()): string {
  return join(home, "Library", "Logs", "Devil Codex", "stock-bridge.log");
}

export function buildMacStockProxyPlist(executable: string, logPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${STOCK_PROXY_LAUNCH_AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlString(executable)}</string>
    <string>--devil-stock-proxy</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xmlString(logPath)}</string>
  <key>StandardErrorPath</key><string>${xmlString(logPath)}</string>
</dict>
</plist>
`;
}

export function stockProxyTaskArgs(executable: string): string[] {
  // schtasks stores one command string; quote the executable so an installed
  // path such as Program Files/Devil Codex remains one argument.
  return [
    "/Create",
    "/TN", STOCK_PROXY_TASK_NAME,
    "/TR", `"${executable}" --devil-stock-proxy`,
    "/SC", "ONLOGON",
    "/RL", "LIMITED",
    "/F",
  ];
}

// The stock Codex bridge is meaningful only after a packaged Devil install.
// Never register a task for a source checkout because node_modules paths move.
export async function ensureStockProxyAutostart(input: { packaged: boolean; executable: string; platform?: NodeJS.Platform; home?: string }): Promise<boolean> {
  if (!input.packaged) return false;
  const platform = input.platform ?? process.platform;
  if (platform === "win32") {
    await execFileAsync("schtasks.exe", stockProxyTaskArgs(input.executable), { windowsHide: true });
    return true;
  }
  if (platform === "darwin") {
    const home = input.home ?? homedir();
    const path = stockProxyLaunchAgentPath(home);
    const log = stockProxyLogPath(home);
    await mkdir(dirname(log), { recursive: true });
    await writeTextFileAtomic(path, buildMacStockProxyPlist(input.executable, log));
    // Do not bootstrap while the desktop owns the fixed proxy port. launchd
    // discovers this RunAtLoad agent at the next login; normal app shutdown
    // performs the immediate headless handoff itself.
    return true;
  }
  return false;
}

export async function disableStockProxyAutostart(input: { platform?: NodeJS.Platform; home?: string } = {}): Promise<boolean> {
  const platform = input.platform ?? process.platform;
  if (platform === "win32") {
    try {
      await execFileAsync("schtasks.exe", ["/Delete", "/TN", STOCK_PROXY_TASK_NAME, "/F"], { windowsHide: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/cannot find|not found|지정된 파일|찾을 수/i.test(message)) throw error;
    }
    return true;
  }
  if (platform === "darwin") {
    const path = stockProxyLaunchAgentPath(input.home ?? homedir());
    if (typeof process.getuid === "function") {
      await execFileAsync("launchctl", ["bootout", `gui/${process.getuid()}`, path], { windowsHide: true }).catch(() => undefined);
    }
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    return true;
  }
  return false;
}
