/**
 * Antigravity (Cloud Code Assist) thought-signature replay.
 *
 * Gemini tool calls carry an opaque thoughtSignature that must be echoed on the
 * matching functionCall in later turns. Responses call ids are not stable
 * enough for that job, so replay is keyed by model/session and canonicalized
 * function-call identity, matching OpenCodex's proxy behavior.
 */

interface ReplayEntry {
  byCall: Map<string, string>;
  expiresAtMs: number;
}

const MIN_SIGNATURE_LENGTH = 16;
const REPLAY_TTL_MS = 60 * 60 * 1000;
const REPLAY_MAX_ENTRIES = 10_240;
const REPLAY_EVICT_BATCH = 128;

const replayCache = new Map<string, ReplayEntry>();

function replayKey(model: string, sessionId: string): string {
  return `${model}::session:${sessionId}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function functionCallKey(name: unknown, args: unknown): string | undefined {
  if (typeof name !== "string" || !name) return undefined;
  return `${name}::${canonicalJson(args ?? {})}`;
}

function isReplayableSignature(signature: string | undefined): signature is string {
  if (typeof signature !== "string" || signature.length < MIN_SIGNATURE_LENGTH) return false;
  if (/^(fc|ctc|tsc|call|msg|rs|resp|reasoning|item|ws|tool|func|function)[-_]/i.test(signature)) return false;
  return /^[A-Za-z0-9+/_=-]+$/.test(signature);
}

function evictIfNeeded(): void {
  if (replayCache.size <= REPLAY_MAX_ENTRIES) return;
  const oldest = [...replayCache.entries()]
    .sort((left, right) => left[1].expiresAtMs - right[1].expiresAtMs)
    .slice(0, REPLAY_EVICT_BATCH);
  for (const [key] of oldest) replayCache.delete(key);
}

export function antigravityUsesReplayCache(model: string): boolean {
  return !/claude/i.test(model);
}

export function observeAntigravityReplayCall(
  model: string,
  sessionId: string,
  name: unknown,
  args: unknown,
  signature: string | undefined,
): void {
  if (!antigravityUsesReplayCache(model) || !isReplayableSignature(signature)) return;
  const callKey = functionCallKey(name, args);
  if (!callKey) return;
  const key = replayKey(model, sessionId);
  const entry = replayCache.get(key) ?? { byCall: new Map<string, string>(), expiresAtMs: 0 };
  entry.byCall.set(callKey, signature);
  entry.expiresAtMs = Date.now() + REPLAY_TTL_MS;
  replayCache.set(key, entry);
  evictIfNeeded();
}

export function applyAntigravityReplay(model: string, sessionId: string, contents: unknown[]): unknown[] {
  if (!antigravityUsesReplayCache(model) || !Array.isArray(contents)) return contents;
  const key = replayKey(model, sessionId);
  const entry = replayCache.get(key);
  if (!entry || entry.expiresAtMs <= Date.now()) {
    if (entry) replayCache.delete(key);
    return contents;
  }
  for (const content of contents as Array<{ role?: string; parts?: unknown[] }>) {
    if (!content || content.role !== "model" || !Array.isArray(content.parts)) continue;
    for (const raw of content.parts) {
      if (!raw || typeof raw !== "object") continue;
      const part = raw as Record<string, unknown>;
      if (isReplayableSignature(part.thoughtSignature as string | undefined)
        || isReplayableSignature(part.thought_signature as string | undefined)) continue;
      const call = part.functionCall as { name?: unknown; args?: unknown } | undefined;
      if (!call) continue;
      const callKey = functionCallKey(call.name, call.args);
      const signature = callKey ? entry.byCall.get(callKey) : undefined;
      if (signature) part.thoughtSignature = signature;
    }
  }
  return contents;
}

export function sanitizeAntigravityClaudeSignatures(contents: unknown[]): unknown[] {
  if (!Array.isArray(contents)) return contents;
  for (const content of contents as Array<{ role?: string; parts?: Array<Record<string, unknown>> }>) {
    if (!content || !Array.isArray(content.parts)) continue;
    if (content.role !== "model") {
      for (const part of content.parts) {
        delete part.thoughtSignature;
        delete part.thought_signature;
      }
      continue;
    }
    content.parts = content.parts.filter((part) => {
      if (part.thought !== true) return true;
      return isReplayableSignature(part.thoughtSignature as string | undefined)
        || isReplayableSignature(part.thought_signature as string | undefined);
    });
  }
  return contents;
}

export function clearAntigravityReplay(model: string, sessionId: string): void {
  replayCache.delete(replayKey(model, sessionId));
}

export function resetAntigravityReplayForTests(): void {
  replayCache.clear();
}
