import { appendFile, chmod, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

export type DiagnosticScope = "app" | "bridge";
export type DiagnosticLevel = "debug" | "info" | "warn" | "error";

export interface DiagnosticLoggerOptions {
  directory: string;
  role: string;
  maxFileBytes?: number;
  maxFiles?: number;
  maxRecordBytes?: number;
  now?: () => Date;
  pid?: number;
  sessionId?: string;
}

interface WriterState {
  initialized: boolean;
  bytes: number;
}

const SENSITIVE_KEYS = new Set([
  "authorization",
  "proxyauthorization",
  "xapikey",
  "xgoogapikey",
  "xauthtoken",
  "xoaiattestation",
  "xclaudecodesessionid",
  "apikey",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "oauthtoken",
  "sessiontoken",
  "credential",
  "credentials",
  "clientsecret",
  "codeverifier",
  "privatekey",
  "signingkey",
  "encryptionkey",
  "awssecretaccesskey",
  "password",
  "passwd",
  "cookie",
  "setcookie",
  "secret",
  "proxysecret",
]);

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function summarizeBinary(value: Uint8Array, type: string, mimeType?: string): Record<string, unknown> {
  return {
    type,
    ...(mimeType ? { mimeType } : {}),
    bytes: value.byteLength,
    sha256: sha256(value),
    omitted: true,
  };
}

function replaceDataUrls(text: string): string {
  return text.replace(/data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([a-z0-9+/_=-]{128,})/gi, (_match, mimeType: string, encoded: string) => {
    try {
      const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
      const bytes = Buffer.from(normalized, "base64");
      return `[data-url omitted mime=${mimeType} bytes=${bytes.byteLength} sha256=${sha256(bytes)}]`;
    } catch {
      return `[data-url omitted mime=${mimeType} encodedChars=${encoded.length}]`;
    }
  });
}

export function redactDiagnosticText(input: string): string {
  let text = replaceDataUrls(input);
  text = text
    .replace(/((?:"|')?(?:data|base64|image_data)(?:"|')?\s*:\s*["'])([a-z0-9+/_=-]{512,})(["'])/gi, (_match, prefix: string, encoded: string, quote: string) => {
      const bytes = Buffer.from(encoded.replace(/-/g, "+").replace(/_/g, "/"), "base64");
      return `${prefix}[base64 omitted encodedChars=${encoded.length} bytes=${bytes.byteLength} sha256=${sha256(bytes)}]${quote}`;
    })
    .replace(/-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)* PRIVATE KEY-----/g, "[redacted-private-key]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s:]+:[^/@\s]+@/gi, "$1[redacted-userinfo]@")
    .replace(/\b(bearer|basic)\s+[a-z0-9._~+\/-]{8,}=*/gi, "$1 [redacted]")
    .replace(/((?:"|')?(?:authorization|proxy-authorization|x-api-key|x-goog-api-key|x-auth-token|x-oai-attestation|x-claude-code-session-id|api[-_]?key|token|access[-_]?token|refresh[-_]?token|id[-_]?token|oauth[-_]?token|session[-_]?token|secret|client[-_]?secret|code[-_]?verifier|private[-_]?key|aws[-_]?secret[-_]?access[-_]?key|password|passwd|cookie|set-cookie)(?:"|')?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi, "$1[redacted]")
    .replace(/([?&](?:key|api_key|access_token|refresh_token|id_token|token|auth|signature|code|code_verifier)=)[^&#\s"']+/gi, "$1[redacted]")
    .replace(/\bsk-[a-z0-9_-]{12,}\b/gi, "[redacted-api-key]")
    .replace(/\bAIza[a-z0-9_-]{20,}\b/gi, "[redacted-google-key]")
    .replace(/\bgh[pousr]_[a-z0-9]{20,}\b/gi, "[redacted-github-token]")
    .replace(/\bgithub_pat_[a-z0-9_]{20,}\b/gi, "[redacted-github-token]")
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[redacted-aws-key]")
    .replace(/\bglpat-[a-z0-9_-]{20,}\b/gi, "[redacted-gitlab-token]")
    .replace(/\bya29\.[a-z0-9_-]{20,}\b/gi, "[redacted-oauth-token]")
    .replace(/\b[a-z0-9_-]{20,}\.[a-z0-9_-]{20,}\.[a-z0-9_-]{20,}\b/gi, "[redacted-token]")
    .replace(/\/[a-f0-9]{32,}(?=\/(?:stock\/)?v1\b)/gi, "/[redacted-proxy-secret]");
  return text;
}

function diagnosticValueExceeds(value: unknown, limit: number, seen = new WeakSet<object>()): boolean {
  let remaining = limit;
  const visit = (entry: unknown, depth: number): boolean => {
    if (remaining < 0) return true;
    if (entry === null || entry === undefined) { remaining -= 4; return remaining < 0; }
    if (typeof entry === "string") { remaining -= Math.min(Buffer.byteLength(entry), limit + 1); return remaining < 0; }
    if (typeof entry === "number" || typeof entry === "boolean" || typeof entry === "bigint") { remaining -= 16; return remaining < 0; }
    if (typeof entry !== "object") { remaining -= 32; return remaining < 0; }
    if (Buffer.isBuffer(entry) || entry instanceof Uint8Array) { remaining -= Math.min(entry.byteLength, limit + 1); return remaining < 0; }
    if (entry instanceof ArrayBuffer) { remaining -= Math.min(entry.byteLength, limit + 1); return remaining < 0; }
    if (entry instanceof Date || entry instanceof URL) { remaining -= 64; return remaining < 0; }
    if (depth > 24 || seen.has(entry)) { remaining -= 16; return remaining < 0; }
    seen.add(entry);
    try {
      if (entry instanceof Error) {
        if (visit(entry.name, depth + 1) || visit(entry.message, depth + 1) || visit(entry.stack, depth + 1)) return true;
        return "cause" in entry ? visit((entry as Error & { cause?: unknown }).cause, depth + 1) : false;
      }
      if (entry instanceof Map) {
        for (const [key, child] of entry) if (visit(key, depth + 1) || visit(child, depth + 1)) return true;
        return false;
      }
      if (entry instanceof Set) {
        for (const child of entry) if (visit(child, depth + 1)) return true;
        return false;
      }
      for (const [key, child] of Object.entries(entry)) {
        remaining -= Buffer.byteLength(key) + 4;
        if (remaining < 0 || visit(child, depth + 1)) return true;
      }
      return false;
    } catch {
      return true;
    } finally {
      seen.delete(entry);
    }
  };
  return visit(value, 0);
}

function sanitizeValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") return `[Function ${value.name || "anonymous"}]`;
  if (typeof value === "string") {
    const redacted = redactDiagnosticText(value);
    if (redacted.length >= 512 && /^[a-z0-9+/_=-]+$/i.test(redacted)) {
      const bytes = Buffer.from(redacted.replace(/-/g, "+").replace(/_/g, "/"), "base64");
      return `[base64 omitted encodedChars=${redacted.length} bytes=${bytes.byteLength} sha256=${sha256(bytes)}]`;
    }
    return redacted;
  }
  if (depth > 24) return "[MaxDepth]";
  if (Buffer.isBuffer(value)) return summarizeBinary(value, "Buffer");
  if (value instanceof Uint8Array) return summarizeBinary(value, value.constructor.name);
  if (value instanceof ArrayBuffer) return summarizeBinary(new Uint8Array(value), "ArrayBuffer");
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : "Invalid Date";
  if (value instanceof URL) return redactDiagnosticText(value.toString());
  if (value instanceof Error) {
    if (seen.has(value)) return "[Circular Error]";
    seen.add(value);
    const error = value as Error & { code?: unknown; cause?: unknown };
    const result = {
      name: error.name,
      message: redactDiagnosticText(error.message),
      ...(error.stack ? { stack: redactDiagnosticText(error.stack) } : {}),
      ...(error.code !== undefined ? { code: sanitizeValue(error.code, seen, depth + 1) } : {}),
      ...(error.cause !== undefined ? { cause: sanitizeValue(error.cause, seen, depth + 1) } : {}),
    };
    seen.delete(value);
    return result;
  }
  if (typeof value !== "object") return redactDiagnosticText(String(value));
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry) => sanitizeValue(entry, seen, depth + 1));
    if (value instanceof Map) return [...value.entries()].map(([key, entry]) => [sanitizeValue(key, seen, depth + 1), sanitizeValue(entry, seen, depth + 1)]);
    if (value instanceof Set) return [...value.values()].map((entry) => sanitizeValue(entry, seen, depth + 1));
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = SENSITIVE_KEYS.has(normalizedKey(key)) ? "[redacted]" : sanitizeValue(entry, seen, depth + 1);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function sanitizeDiagnosticValue(value: unknown): unknown {
  try {
    return sanitizeValue(value, new WeakSet<object>(), 0);
  } catch (error) {
    return { serializationError: error instanceof Error ? redactDiagnosticText(error.message) : redactDiagnosticText(String(error)) };
  }
}

function safeRole(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "process";
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : undefined;
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return errorCode(error) === "EPERM"; }
}

export class DiagnosticLogger {
  readonly directory: string;
  readonly role: string;
  readonly sessionId: string;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private readonly maxRecordBytes: number;
  private readonly now: () => Date;
  private readonly pid: number;
  private readonly fileSession: string;
  private readonly maxLogicalBytes: number;
  private readonly state: Record<DiagnosticScope, WriterState> = {
    app: { initialized: false, bytes: 0 },
    bridge: { initialized: false, bytes: 0 },
  };
  private queue: Promise<void> = Promise.resolve();
  private sequence = 0;
  private lastWriteError: Error | undefined;
  private writeErrorReported = false;
  private droppedRecords = 0;
  private retentionPruned = false;

  constructor(options: DiagnosticLoggerOptions) {
    this.directory = options.directory;
    this.role = safeRole(options.role);
    this.sessionId = options.sessionId ?? randomUUID();
    this.maxFileBytes = Math.max(4_096, options.maxFileBytes ?? 32 * 1024 * 1024);
    this.maxFiles = Math.max(1, Math.floor(options.maxFiles ?? 8));
    this.maxRecordBytes = Math.max(2_048, Math.min(this.maxFileBytes, options.maxRecordBytes ?? 4 * 1024 * 1024));
    this.now = options.now ?? (() => new Date());
    this.pid = options.pid ?? process.pid;
    this.fileSession = safeRole(this.sessionId).slice(0, 12);
    this.maxLogicalBytes = Math.max(this.maxRecordBytes, Math.min(16 * 1024 * 1024, Math.floor(this.maxFileBytes * this.maxFiles * 0.5)));
  }

  activePath(scope: DiagnosticScope): string {
    return join(this.directory, `${scope}-${this.role}-${this.pid}-${this.fileSession}.jsonl`);
  }

  log(scope: DiagnosticScope, event: string, data: unknown = {}, context: unknown = {}, level: DiagnosticLevel = "info"): void {
    let lines: string[];
    try {
      lines = this.serialize(scope, event, data, context, level);
    } catch (error) {
      const fallback = {
        timestamp: this.now().toISOString(),
        sessionId: this.sessionId,
        sequence: ++this.sequence,
        pid: this.pid,
        role: this.role,
        scope,
        level: "error",
        event: "diagnostic.serialization_error",
        data: sanitizeDiagnosticValue(error),
      };
      lines = [`${JSON.stringify(fallback)}\n`];
    }
    this.queue = this.queue.then(async () => {
      for (const line of lines) await this.writeLine(scope, line);
      if (this.lastWriteError) {
        const droppedRecords = this.droppedRecords;
        this.lastWriteError = undefined;
        this.droppedRecords = 0;
        this.writeErrorReported = false;
        try { process.stderr.write(`[devil-codex diagnostics] write recovered after dropping ${droppedRecords} record(s)\n`); } catch { /* final fallback only */ }
      }
    }).catch((error) => {
      this.lastWriteError = error instanceof Error ? error : new Error(String(error));
      this.droppedRecords += lines.length;
      if (!this.writeErrorReported) {
        this.writeErrorReported = true;
        try { process.stderr.write(`[devil-codex diagnostics] write failed: ${redactDiagnosticText(this.lastWriteError.message)}\n`); } catch { /* final fallback only */ }
      }
    });
  }

  async flush(): Promise<void> {
    await this.queue;
    if (this.lastWriteError) throw this.lastWriteError;
  }

  private base(scope: DiagnosticScope, event: string, level: DiagnosticLevel): Record<string, unknown> {
    return {
      timestamp: this.now().toISOString(),
      sessionId: this.sessionId,
      pid: this.pid,
      role: this.role,
      scope,
      level,
      event: redactDiagnosticText(event),
    };
  }

  private serialize(scope: DiagnosticScope, event: string, data: unknown, context: unknown, level: DiagnosticLevel): string[] {
    const contextTooLarge = diagnosticValueExceeds(context, Math.min(this.maxLogicalBytes, 256 * 1024));
    const dataTooLarge = diagnosticValueExceeds(data, this.maxLogicalBytes);
    const safeContext = contextTooLarge ? { omitted: true, reason: "context exceeds diagnostic limit", limitBytes: Math.min(this.maxLogicalBytes, 256 * 1024) } : sanitizeDiagnosticValue(context);
    const safeData = dataTooLarge ? { omitted: true, reason: "payload exceeds diagnostic limit", limitBytes: this.maxLogicalBytes } : sanitizeDiagnosticValue(data);
    const contextRecord = safeContext && typeof safeContext === "object" && !Array.isArray(safeContext) ? safeContext as Record<string, unknown> : {};
    const common = this.base(scope, event, level);
    const topLevelCorrelation: Record<string, unknown> = {};
    for (const key of ["requestId", "threadId", "provider", "model", "transport", "route", "upstreamRequestId", "processRole"]) {
      if (contextRecord[key] !== undefined) topLevelCorrelation[key] = contextRecord[key];
    }
    const sequence = ++this.sequence;
    const record = { ...common, sequence, ...topLevelCorrelation, context: safeContext, data: safeData };
    const line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line) <= this.maxRecordBytes) return [line];

    const payload = Buffer.from(JSON.stringify({ context: safeContext, data: safeData }), "utf8");
    if (payload.byteLength > this.maxLogicalBytes) {
      return [`${JSON.stringify({
        ...common,
        sequence,
        ...topLevelCorrelation,
        data: { omitted: true, reason: "sanitized payload exceeds diagnostic limit", originalBytes: payload.byteLength, sha256: sha256(payload) },
      })}\n`];
    }
    const payloadSha256 = sha256(payload);
    const rawChunkBytes = Math.max(256, Math.floor((this.maxRecordBytes - 1_536) * 0.70));
    const count = Math.ceil(payload.byteLength / rawChunkBytes);
    const lines: string[] = [];
    for (let index = 0; index < count; index += 1) {
      const chunk = payload.subarray(index * rawChunkBytes, Math.min(payload.byteLength, (index + 1) * rawChunkBytes));
      lines.push(`${JSON.stringify({
        ...common,
        sequence: index === 0 ? sequence : ++this.sequence,
        logicalSequence: sequence,
        ...topLevelCorrelation,
        chunk: {
          index,
          count,
          encoding: "base64-json",
          originalBytes: payload.byteLength,
          sha256: payloadSha256,
          data: chunk.toString("base64"),
        },
      })}\n`);
    }
    return lines;
  }

  private async initialize(scope: DiagnosticScope): Promise<void> {
    const state = this.state[scope];
    if (state.initialized) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    if (!this.retentionPruned) {
      this.retentionPruned = true;
      await this.pruneRetention();
    }
    const info = await stat(this.activePath(scope)).catch(() => undefined);
    state.bytes = info?.size ?? 0;
    if (info) await chmod(this.activePath(scope), 0o600);
    state.initialized = true;
  }

  private async pruneRetention(): Promise<void> {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1_000;
    const entries = await readdir(this.directory, { withFileTypes: true });
    const prefixPattern = /^(app|bridge)-[a-z0-9._-]+-(\d+)-[a-z0-9._-]+\.jsonl(?:\.(\d+))?$/;
    const files = (await Promise.all(entries.filter((entry) => entry.isFile() && prefixPattern.test(entry.name)).map(async (entry) => {
      const path = join(this.directory, entry.name);
      const info = await stat(path);
      const match = entry.name.match(prefixPattern);
      return { path, mtimeMs: info.mtimeMs, size: info.size, pid: Number(match?.[2] ?? 0), rotated: match?.[3] !== undefined };
    }))).sort((a, b) => a.mtimeMs - b.mtimeMs);
    let totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    for (const file of files) {
      if (file.mtimeMs >= cutoff && totalBytes <= 512 * 1024 * 1024) continue;
      if (file.path === this.activePath("app") || file.path === this.activePath("bridge")) continue;
      if (!file.rotated && file.pid > 0 && processIsAlive(file.pid)) continue;
      await rm(file.path, { force: true });
      totalBytes -= file.size;
    }
  }

  private async rotate(scope: DiagnosticScope): Promise<void> {
    const active = this.activePath(scope);
    if (this.maxFiles <= 1) {
      await rm(active, { force: true });
      this.state[scope].bytes = 0;
      return;
    }
    await rm(`${active}.${this.maxFiles - 1}`, { force: true }).catch(() => undefined);
    for (let index = this.maxFiles - 2; index >= 1; index -= 1) {
      try { await rename(`${active}.${index}`, `${active}.${index + 1}`); }
      catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
    }
    try { await rename(active, `${active}.1`); }
    catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
    this.state[scope].bytes = 0;
  }

  private async writeLine(scope: DiagnosticScope, line: string): Promise<void> {
    await this.initialize(scope);
    const bytes = Buffer.byteLength(line);
    if (this.state[scope].bytes > 0 && this.state[scope].bytes + bytes > this.maxFileBytes) await this.rotate(scope);
    const path = this.activePath(scope);
    await appendFile(path, line, { encoding: "utf8", mode: 0o600 });
    if (this.state[scope].bytes === 0) await chmod(path, 0o600);
    this.state[scope].bytes += bytes;
  }
}

let activeLogger: DiagnosticLogger | undefined;

export function configureDiagnostics(options: DiagnosticLoggerOptions): DiagnosticLogger {
  activeLogger = new DiagnosticLogger(options);
  return activeLogger;
}

export function diagnosticLog(scope: DiagnosticScope, event: string, data: unknown = {}, context: unknown = {}, level: DiagnosticLevel = "info"): void {
  activeLogger?.log(scope, event, data, context, level);
}

export function diagnosticsDirectory(): string {
  return activeLogger?.directory ?? "";
}

export async function flushDiagnostics(): Promise<void> {
  try {
    await activeLogger?.flush();
  } catch (error) {
    try { process.stderr.write(`[devil-codex diagnostics] flush failed: ${redactDiagnosticText(error instanceof Error ? error.message : String(error))}\n`); } catch { /* no further fallback */ }
  }
}
