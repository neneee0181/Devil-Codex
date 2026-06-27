import * as pty from "node-pty";
import { spawn } from "node:child_process";

export interface TerminalSession { id: string; cwd: string; shell: string; fallback: boolean; }
type TerminalProcess = { write: (data: string) => void; resize: (cols: number, rows: number) => void; kill: () => void };

export class TerminalManager {
  private sessions = new Map<string, TerminalProcess>();
  private nextId = 1;

  constructor(private readonly emit: (payload: { id: string; data: string }) => void) {}

  create(cwd: string, cols = 100, rows = 24): TerminalSession {
    const id = `terminal-${this.nextId++}`;
    const shell = process.platform === "win32" ? process.env.COMSPEC || "cmd.exe" : process.env.SHELL || "/bin/zsh";
    const terminalCwd = cwd || process.cwd();
    let processRef: TerminalProcess;
    let fallback = false;
    try {
      const native = pty.spawn(shell, [], { name: "xterm-256color", cwd: terminalCwd, cols, rows, env: process.env as Record<string, string> });
      native.onData((data) => this.emit({ id, data }));
      native.onExit(() => this.sessions.delete(id));
      processRef = native;
    } catch {
      fallback = true;
      const child = spawn(shell, ["-i"], { cwd: terminalCwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
      child.stdout.on("data", (data: Buffer) => this.emit({ id, data: data.toString() }));
      child.stderr.on("data", (data: Buffer) => this.emit({ id, data: data.toString() }));
      child.on("exit", () => this.sessions.delete(id));
      processRef = {
        write: (data) => child.stdin.write(data.replace(/\r/g, "\n")),
        resize: () => undefined,
        kill: () => child.kill(),
      };
      this.emit({ id, data: "\u001b[33mPTY를 사용할 수 없어 호환 shell 모드로 실행합니다.\u001b[0m\r\n" });
    }
    this.sessions.set(id, processRef);
    return { id, cwd: terminalCwd, shell, fallback };
  }

  write(id: string, data: string): void { this.sessions.get(id)?.write(data); }
  resize(id: string, cols: number, rows: number): void { this.sessions.get(id)?.resize(Math.max(2, cols), Math.max(2, rows)); }
  close(id: string): void { this.sessions.get(id)?.kill(); this.sessions.delete(id); }
  dispose(): void { for (const id of this.sessions.keys()) this.close(id); }
}
