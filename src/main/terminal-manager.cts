import * as pty from "node-pty";
import { spawn } from "node:child_process";

export interface TerminalSession { id: string; cwd: string; shell: string; fallback: boolean; buffer?: string; key?: string; }
type TerminalProcess = { write: (data: string) => void; resize: (cols: number, rows: number) => void; kill: () => void };
type TerminalRecord = TerminalProcess & { meta: TerminalSession; buffer: string; key?: string };

const BUFFER_LIMIT = 120_000;

export class TerminalManager {
  private sessions = new Map<string, TerminalRecord>();
  private keyedSessions = new Map<string, string>();
  private nextId = 1;

  constructor(private readonly emit: (payload: { id: string; data: string }) => void) {}

  create(cwd: string, cols = 100, rows = 24, key?: string): TerminalSession {
    const existingId = key ? this.keyedSessions.get(key) : undefined;
    const existing = existingId ? this.sessions.get(existingId) : undefined;
    if (existing) {
      existing.resize(cols, rows);
      return { ...existing.meta, buffer: existing.buffer, key };
    }
    const id = `terminal-${this.nextId++}`;
    const shell = process.platform === "win32" ? process.env.COMSPEC || "cmd.exe" : process.env.SHELL || "/bin/zsh";
    const terminalCwd = cwd || process.cwd();
    let processRef: TerminalProcess;
    let fallback = false;
    const append = (data: string): void => {
      const record = this.sessions.get(id);
      if (record) record.buffer = `${record.buffer}${data}`.slice(-BUFFER_LIMIT);
      this.emit({ id, data });
    };
    try {
      const native = pty.spawn(shell, [], { name: "xterm-256color", cwd: terminalCwd, cols, rows, env: process.env as Record<string, string> });
      native.onData(append);
      native.onExit(() => this.deleteSession(id));
      processRef = {
        write: (data) => native.write(data),
        resize: (nextCols, nextRows) => native.resize(Math.max(2, nextCols), Math.max(2, nextRows)),
        kill: () => native.kill(),
      };
    } catch {
      fallback = true;
      const child = spawn(shell, ["-i"], { cwd: terminalCwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
      child.stdout.on("data", (data: Buffer) => append(data.toString()));
      child.stderr.on("data", (data: Buffer) => append(data.toString()));
      child.on("exit", () => this.deleteSession(id));
      processRef = {
        write: (data) => child.stdin.write(data.replace(/\r/g, "\n")),
        resize: () => undefined,
        kill: () => child.kill(),
      };
      append("\u001b[33mPTY를 사용할 수 없어 호환 shell 모드로 실행합니다.\u001b[0m\r\n");
    }
    const meta = { id, cwd: terminalCwd, shell, fallback };
    this.sessions.set(id, { ...processRef, meta, buffer: "", key });
    if (key) this.keyedSessions.set(key, id);
    return { ...meta, key };
  }

  write(id: string, data: string): void { this.sessions.get(id)?.write(data); }
  resize(id: string, cols: number, rows: number): void { this.sessions.get(id)?.resize(Math.max(2, cols), Math.max(2, rows)); }
  close(id: string): void { this.sessions.get(id)?.kill(); this.deleteSession(id); }
  dispose(): void { for (const id of this.sessions.keys()) this.close(id); }

  private deleteSession(id: string): void {
    const record = this.sessions.get(id);
    if (record?.key) this.keyedSessions.delete(record.key);
    this.sessions.delete(id);
  }
}
