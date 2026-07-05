import * as pty from "node-pty";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type TerminalShellId = "auto" | "wsl" | "git-bash" | "pwsh" | "powershell" | "cmd";
export interface TerminalShellProfile { id: TerminalShellId; label: string; available: boolean; path?: string; detail?: string; }
export interface TerminalSession { id: string; cwd: string; shell: string; fallback: boolean; buffer?: string; key?: string; shellId?: TerminalShellId; shellLabel?: string; }
type TerminalProcess = { write: (data: string) => void; resize: (cols: number, rows: number) => void; kill: () => void };
type TerminalRecord = TerminalProcess & { meta: TerminalSession; buffer: string; key?: string };

const BUFFER_LIMIT = 120_000;
const WINDOWS_PATH_EXTENSIONS = [".exe", ".cmd", ".bat", ""];

type ResolvedShell = { id: TerminalShellId; label: string; command: string; args: string[]; cwd: string };

function pathEntries(): string[] {
  return (process.env.PATH ?? "").split(";").filter(Boolean);
}

function findOnPath(command: string): string | undefined {
  if (process.platform !== "win32") return undefined;
  for (const dir of pathEntries()) {
    for (const ext of WINDOWS_PATH_EXTENSIONS) {
      const candidate = join(dir, command.toLowerCase().endsWith(ext) ? command : `${command}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function firstExisting(paths: string[]): string | undefined {
  return paths.find((path) => existsSync(path));
}

function gitBashPath(): string | undefined {
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const userProfile = process.env.USERPROFILE ?? "";
  return firstExisting([
    join(programFiles, "Git", "bin", "bash.exe"),
    join(programFiles, "Git", "usr", "bin", "bash.exe"),
    join(programFilesX86, "Git", "bin", "bash.exe"),
    localAppData ? join(localAppData, "Programs", "Git", "bin", "bash.exe") : "",
    userProfile ? join(userProfile, "scoop", "apps", "git", "current", "bin", "bash.exe") : "",
    findOnPath("bash.exe") ?? "",
  ].filter(Boolean));
}

function windowsPathToWsl(path: string): string {
  const match = path.match(/^([A-Za-z]):[\\/](.*)$/);
  if (!match) return path.replace(/\\/g, "/");
  return `/mnt/${match[1]!.toLowerCase()}/${match[2]!.replace(/\\/g, "/")}`;
}

function availableShellProfiles(): TerminalShellProfile[] {
  if (process.platform !== "win32") {
    return [
      { id: "auto", label: "자동", available: true, detail: "시스템 기본 shell" },
      { id: "cmd", label: process.env.SHELL || "/bin/zsh", available: true, path: process.env.SHELL || "/bin/zsh" },
    ];
  }
  const wsl = findOnPath("wsl.exe") ?? firstExisting([join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wsl.exe")]);
  const gitBash = gitBashPath();
  const pwsh = findOnPath("pwsh.exe");
  const powershell = findOnPath("powershell.exe") ?? firstExisting([join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe")]);
  const cmd = process.env.COMSPEC || findOnPath("cmd.exe") || "cmd.exe";
  const profiles: TerminalShellProfile[] = [
    { id: "auto", label: "자동", available: true, detail: "WSL → Git Bash → PowerShell 7 → Windows PowerShell → cmd 순서" },
    { id: "wsl", label: "WSL Bash", available: Boolean(wsl), path: wsl, detail: wsl ? "Linux-like shell" : "wsl.exe를 찾을 수 없음" },
    { id: "git-bash", label: "Git Bash", available: Boolean(gitBash), path: gitBash, detail: gitBash ? "Git for Windows bash" : "Git Bash를 찾을 수 없음" },
    { id: "pwsh", label: "PowerShell 7", available: Boolean(pwsh), path: pwsh, detail: pwsh ? "pwsh.exe" : "PowerShell 7을 찾을 수 없음" },
    { id: "powershell", label: "Windows PowerShell", available: Boolean(powershell), path: powershell, detail: "Windows 기본 PowerShell" },
    { id: "cmd", label: "Command Prompt", available: true, path: cmd, detail: "Windows cmd.exe" },
  ];
  return profiles;
}

function resolveShell(requested: TerminalShellId | undefined, cwd: string): ResolvedShell {
  if (process.platform !== "win32") {
    const shell = process.env.SHELL || "/bin/zsh";
    return { id: "auto", label: shell, command: shell, args: [], cwd };
  }
  const profiles = availableShellProfiles();
  const available = (id: TerminalShellId): TerminalShellProfile | undefined => profiles.find((profile) => profile.id === id && profile.available && profile.path);
  const id = requested && requested !== "auto" && available(requested)
    ? requested
    : (available("wsl")?.id ?? available("git-bash")?.id ?? available("pwsh")?.id ?? available("powershell")?.id ?? "cmd");
  const profile = available(id) ?? available("cmd")!;
  if (id === "wsl") return { id, label: profile.label, command: profile.path!, args: ["--cd", windowsPathToWsl(cwd), "--exec", "bash", "-li"], cwd };
  if (id === "git-bash") return { id, label: profile.label, command: profile.path!, args: ["--login", "-i"], cwd };
  if (id === "pwsh" || id === "powershell") return { id, label: profile.label, command: profile.path!, args: ["-NoLogo"], cwd };
  return { id: "cmd", label: profile.label, command: profile.path ?? "cmd.exe", args: [], cwd };
}

function resolveShellCandidates(requested: TerminalShellId | undefined, cwd: string): ResolvedShell[] {
  if (process.platform !== "win32") return [resolveShell(requested, cwd)];
  const requestedShell = resolveShell(requested, cwd);
  if (requested && requested !== "auto") {
    const fallback = requestedShell.id === "cmd" ? [] : [resolveShell("cmd", cwd)];
    return [requestedShell, ...fallback];
  }
  const profiles = availableShellProfiles();
  const candidates: ResolvedShell[] = [];
  for (const id of ["wsl", "git-bash", "pwsh", "powershell", "cmd"] as TerminalShellId[]) {
    const profile = profiles.find((item) => item.id === id && item.available && item.path);
    if (!profile && id !== "cmd") continue;
    const shell = resolveShell(id, cwd);
    if (!candidates.some((item) => item.id === shell.id && item.command === shell.command)) candidates.push(shell);
  }
  return candidates.length ? candidates : [requestedShell];
}

export class TerminalManager {
  private sessions = new Map<string, TerminalRecord>();
  private keyedSessions = new Map<string, string>();
  private nextId = 1;

  constructor(private readonly emit: (payload: { id: string; data: string }) => void) {}

  profiles(): TerminalShellProfile[] { return availableShellProfiles(); }

  create(cwd: string, cols = 100, rows = 24, key?: string, shellId?: TerminalShellId): TerminalSession {
    const requestedCwd = cwd || process.cwd();
    const missingCwd = !existsSync(requestedCwd);
    const terminalCwd = missingCwd ? process.cwd() : requestedCwd;
    const shells = resolveShellCandidates(shellId, terminalCwd);
    let shell = shells[0]!;
    const existingId = key ? this.keyedSessions.get(key) : undefined;
    const existing = existingId ? this.sessions.get(existingId) : undefined;
    if (existing && existing.meta.shellId === shell.id) {
      existing.resize(cols, rows);
      return { ...existing.meta, buffer: existing.buffer, key };
    }
    if (existing) this.close(existing.meta.id);
    const id = `terminal-${this.nextId++}`;
    let processRef: TerminalProcess;
    let fallback = false;
    const append = (data: string): void => {
      const record = this.sessions.get(id);
      if (record) record.buffer = `${record.buffer}${data}`.slice(-BUFFER_LIMIT);
      this.emit({ id, data });
    };
    try {
      let native: pty.IPty | undefined;
      const errors: string[] = [];
      for (const candidate of shells) {
        try {
          native = pty.spawn(candidate.command, candidate.args, { name: "xterm-256color", cwd: candidate.cwd, cols, rows, env: process.env as Record<string, string> });
          shell = candidate;
          break;
        } catch (error) {
          errors.push(`${candidate.label}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (!native) throw new Error(errors.join(" | ") || "PTY spawn failed");
      native.onData(append);
      native.onExit(() => this.deleteSession(id));
      processRef = {
        write: (data) => native.write(data),
        resize: (nextCols, nextRows) => native.resize(Math.max(2, nextCols), Math.max(2, nextRows)),
        kill: () => native.kill(),
      };
    } catch (ptyError) {
      fallback = true;
      shell = shells.find((candidate) => candidate.id === "cmd") ?? shell;
      try {
        const child = spawn(shell.command, shell.args.length ? shell.args : ["-i"], { cwd: terminalCwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
        child.stdout.on("data", (data: Buffer) => append(data.toString()));
        child.stderr.on("data", (data: Buffer) => append(data.toString()));
        child.on("error", (error) => {
          append(`\u001b[31m터미널 shell을 시작하지 못했습니다: ${error.message}\u001b[0m\r\n`);
          this.deleteSession(id);
        });
        child.on("exit", () => this.deleteSession(id));
        processRef = {
          write: (data) => { if (!child.stdin.destroyed) child.stdin.write(data.replace(/\r/g, "\n")); },
          resize: () => undefined,
          kill: () => child.kill(),
        };
      } catch (error) {
        append(`\u001b[31m터미널 shell을 시작하지 못했습니다: ${error instanceof Error ? error.message : String(error)}\u001b[0m\r\n`);
        this.deleteSession(id);
        processRef = { write: () => undefined, resize: () => undefined, kill: () => undefined };
      }
      append(`\u001b[33mPTY를 사용할 수 없어 호환 shell 모드로 실행합니다.${ptyError instanceof Error ? ` (${ptyError.message})` : ""}\u001b[0m\r\n`);
    }
    if (missingCwd) append(`\u001b[33m요청한 프로젝트 경로를 찾을 수 없어 ${terminalCwd}에서 터미널을 열었습니다: ${requestedCwd}\u001b[0m\r\n`);
    const meta = { id, cwd: terminalCwd, shell: shell.command, fallback, shellId: shell.id, shellLabel: shell.label };
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
