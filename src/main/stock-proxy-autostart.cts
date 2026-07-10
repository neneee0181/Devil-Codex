import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
export const STOCK_PROXY_TASK_NAME = "Devil Codex Stock Bridge";

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
export async function ensureStockProxyAutostart(input: { packaged: boolean; executable: string; platform?: NodeJS.Platform }): Promise<boolean> {
  if (!input.packaged || (input.platform ?? process.platform) !== "win32") return false;
  await execFileAsync("schtasks.exe", stockProxyTaskArgs(input.executable), { windowsHide: true });
  return true;
}
