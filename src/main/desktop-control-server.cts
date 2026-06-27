import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DesktopControlManager } from "./desktop-control.cjs";

// Unix domain socket / Windows named pipe (Codex sandboxes the MCP and blocks
// localhost TCP). Mirrors the browser control bridge; lives in ~/.codex on unix.
export function desktopControlPath(): string {
  if (process.platform === "win32") return "\\\\.\\pipe\\devil-codex-computer";
  const codexHome = process.env.DEVIL_CODEX_CODEX_HOME ?? join(homedir(), ".codex");
  return join(codexHome, "devil-computer.sock");
}

// Bridge so the devil_computer MCP (a separate process Codex spawns) can drive
// the OS-level Computer Use engine living in this Electron process. The model
// calls MCP tools → MCP script → here → DesktopControlManager → real desktop.
export class DesktopControlServer {
  private server: Server | undefined;

  constructor(private readonly desktop: DesktopControlManager, private readonly secret: string) {}

  async start(): Promise<string> {
    const path = desktopControlPath();
    if (this.server) return path;
    if (process.platform !== "win32") { try { unlinkSync(path); } catch { /* none */ } }
    await new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => void this.handle(req, res));
      server.once("error", reject);
      server.listen(path, () => { this.server = server; resolve(); });
    });
    return path;
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
    if (process.platform !== "win32") { try { unlinkSync(desktopControlPath()); } catch { /* none */ } }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (code: number, body: unknown): void => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    try {
      if (!this.authorized(req)) return send(403, { error: "forbidden" });
      const url = new URL(req.url ?? "/", "http://localhost");
      const body = await readJson(req);
      switch (url.pathname) {
        case "/screenshot": { const shot = await this.desktop.screenshot(); return send(200, shot); }
        case "/click": return send(200, { ok: await this.desktop.click({ x: body.x as number | undefined, y: body.y as number | undefined, button: body.button as string | undefined, double: body.double as boolean | undefined }) });
        case "/move": await this.desktop.move(Number(body.x ?? 0), Number(body.y ?? 0)); return send(200, { ok: true });
        case "/type": await this.desktop.type(String(body.text ?? "")); return send(200, { ok: true });
        case "/key": await this.desktop.key(String(body.key ?? "")); return send(200, { ok: true });
        case "/scroll": await this.desktop.scroll(Number(body.dy ?? 0)); return send(200, { ok: true });
        case "/windows": return send(200, { windows: await this.desktop.listWindows() });
        default: return send(404, { error: "unknown" });
      }
    } catch (error) {
      send(500, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private authorized(req: IncomingMessage): boolean {
    return Boolean(this.secret && req.headers["x-devil-codex-control-secret"] === this.secret);
  }
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
    req.on("error", () => resolve({}));
  });
}
