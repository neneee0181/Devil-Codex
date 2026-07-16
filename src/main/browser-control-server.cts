import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowserViewManager } from "./browser-view.cjs";

// Use a unix domain socket / Windows named pipe instead of localhost TCP: Codex
// runs the MCP under a seatbelt sandbox that blocks localhost TCP. Place the
// socket in ~/.codex (which the sandbox always allows — codex reads/writes
// there) rather than the Electron tmpdir, which the sandboxed MCP can't reach.
export function browserControlPath(): string {
  if (process.platform === "win32") return "\\\\.\\pipe\\devil-codex-browser";
  const codexHome = process.env.DEVIL_CODEX_CODEX_HOME ?? join(homedir(), ".codex");
  return join(codexHome, "devil-browser.sock");
}

// Local control bridge so the devil_browser MCP (a separate process Codex
// spawns) can drive the embedded browser living in this Electron process. The
// model calls MCP tools → MCP script → here → BrowserViewManager.
export class BrowserControlServer {
  private server: Server | undefined;

  constructor(private readonly browser: BrowserViewManager, private readonly secret: string) {}

  async start(): Promise<string> {
    const path = browserControlPath();
    if (this.server) return path;
    // Remove a stale socket left by a previous/crashed instance so listen() can
    // bind cleanly (named pipes on Windows don't need this).
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
    if (process.platform !== "win32") { try { unlinkSync(browserControlPath()); } catch { /* none */ } }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (code: number, body: unknown): void => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    try {
      if (!this.authorized(req)) return send(403, { error: "forbidden" });
      const url = new URL(req.url ?? "/", "http://localhost");
      const body = await readJson(req);
      // Surface the browser tab whenever the AI touches it (except plain reads).
      if (url.pathname !== "/state") this.browser.requestActivate();
      switch (url.pathname) {
        case "/navigate": { this.browser.navigate(String(body.url ?? "")); return send(200, await this.browser.waitForLoad(3500)); }
        case "/click": return send(200, { ok: await this.browser.aiClick({ x: body.x as number | undefined, y: body.y as number | undefined, selector: body.selector as string | undefined }) });
        case "/type": await this.browser.aiType(String(body.text ?? "")); return send(200, { ok: true });
        case "/key": await this.browser.aiKey(String(body.key ?? "")); return send(200, { ok: true });
        case "/scroll": await this.browser.aiScroll(Number(body.dy ?? 0)); return send(200, { ok: true });
        case "/read": { await this.browser.waitForLoad(6000); return send(200, { text: await this.browser.aiReadText() }); }
        case "/screenshot": return send(200, { dataUrl: await this.browser.screenshot() });
        case "/state": return send(200, this.browser.state());
        default: return send(404, { error: "unknown" });
      }
    } catch (error) {
      send(500, { error: error instanceof Error ? error.message : String(error) });
    }
  }

  isRunning(): boolean {
    return this.server?.listening === true;
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
