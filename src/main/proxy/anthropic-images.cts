/**
 * Anthropic image normalization and request guards.
 *
 * Codex keeps screenshots in conversation history. Anthropic applies limits to
 * the whole request, so an old large screenshot can poison every later turn.
 * Keep recent images useful, progressively shrink older ones, then enforce the
 * provider's count and byte budgets. This is the Sharp/Electron equivalent of
 * OpenCodex's Bun.Image normalization pipeline.
 */
import { createHash } from "node:crypto";
import sharp from "sharp";

interface ImageRef {
  container: unknown[];
  index: number;
  base64: string | null;
  mediaType: string;
}

interface TierSpec {
  maxEdge: number;
  qualities: number[];
  hardCap: number;
}

interface NormalizedEntry {
  ref: ImageRef;
  source: Buffer;
  sourceBase64: string;
  sourceMediaType: string;
  width: number;
  height: number;
  position: number;
  size: number;
  terminal: boolean;
}

type ProcessResult =
  | { kind: "pass"; position: number; size: number }
  | { kind: "encoded"; position: number; data: string; mediaType: string }
  | { kind: "failed"; position: number };

const KiB = 1024;
const MiB = 1024 * 1024;
const TOTAL_IMAGE_BASE64_BUDGET = 20 * MiB;
const MAX_IMAGE_BASE64_LENGTH = 5 * MiB;
const MAX_INPUT_BASE64_LENGTH = 64 * MiB;
const MAX_INPUT_PIXELS = 100_000_000;
const MAX_IMAGES_PER_REQUEST = 100;
const MANY_IMAGE_THRESHOLD = 20;
const CACHE_BYTE_CAP = 64 * MiB;

const TIER_SPECS: TierSpec[] = [
  { maxEdge: 2000, qualities: [80, 60, 40, 30], hardCap: 2 * MiB },
  { maxEdge: 1024, qualities: [70, 50], hardCap: 512 * KiB },
  { maxEdge: 700, qualities: [60, 40], hardCap: 192 * KiB },
  { maxEdge: 500, qualities: [40], hardCap: 100 * KiB },
  { maxEdge: 400, qualities: [30], hardCap: 100 * KiB },
  { maxEdge: 320, qualities: [25], hardCap: Number.POSITIVE_INFINITY },
];
const TERMINAL_POSITION = TIER_SPECS.length - 1;
const PASSTHROUGH_MEDIA = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

const UNDECODABLE_TEXT = "[image omitted: undecodable or corrupt image data]";
const BOMB_TEXT = "[image omitted: image too large to process safely]";
const COUNT_TEXT = "[image omitted: Anthropic request exceeded the provider image-count limit; older screenshots were dropped]";
const PER_IMAGE_TEXT = "[image omitted: exceeds Anthropic's 5MB per-image limit]";
const BYTE_BUDGET_TEXT = "[image omitted: total image payload exceeded Anthropic's request limit; older screenshots were dropped]";

const normalizationCache = new Map<string, { data: string; mediaType: string } | "pass" | "miss">();
let normalizationCacheBytes = 0;

function cacheGet(key: string): { data: string; mediaType: string } | "pass" | "miss" | undefined {
  const value = normalizationCache.get(key);
  if (value !== undefined) {
    normalizationCache.delete(key);
    normalizationCache.set(key, value);
  }
  return value;
}

function cachePut(key: string, value: { data: string; mediaType: string } | "pass" | "miss"): void {
  const previous = normalizationCache.get(key);
  if (previous && typeof previous !== "string") normalizationCacheBytes -= previous.data.length;
  normalizationCache.delete(key);
  const size = typeof value === "string" ? 0 : value.data.length;
  while (normalizationCacheBytes + size > CACHE_BYTE_CAP && normalizationCache.size) {
    const oldestKey = normalizationCache.keys().next().value as string;
    const oldest = normalizationCache.get(oldestKey);
    if (oldest && typeof oldest !== "string") normalizationCacheBytes -= oldest.data.length;
    normalizationCache.delete(oldestKey);
  }
  normalizationCache.set(key, value);
  normalizationCacheBytes += size;
}

function isImageBlock(value: unknown): value is { type: "image"; source?: Record<string, unknown> } {
  return Boolean(value && typeof value === "object" && (value as { type?: unknown }).type === "image");
}

function collectImageRefs(messages: unknown[]): ImageRef[] {
  const refs: ImageRef[] = [];
  const scan = (blocks: unknown[]): void => {
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index];
      if (isImageBlock(block)) {
        const source = block.source;
        refs.push({
          container: blocks,
          index,
          base64: source?.type === "base64" && typeof source.data === "string" ? source.data : null,
          mediaType: typeof source?.media_type === "string" ? source.media_type.toLowerCase() : "",
        });
      } else if (block && typeof block === "object" && (block as { type?: unknown }).type === "tool_result") {
        const nested = (block as { content?: unknown }).content;
        if (Array.isArray(nested)) scan(nested);
      }
    }
  };
  for (const message of messages) {
    const content = (message as { content?: unknown } | undefined)?.content;
    if (Array.isArray(content)) scan(content);
  }
  return refs;
}

function textify(ref: ImageRef, text: string): void {
  ref.container[ref.index] = { type: "text", text };
}

function replaceImage(ref: ImageRef, data: string, mediaType: string): void {
  ref.container[ref.index] = { type: "image", source: { type: "base64", media_type: mediaType, data } };
}

function initialPosition(newestFirstIndex: number): number {
  return newestFirstIndex < 6 ? 0 : newestFirstIndex < 20 ? 1 : 2;
}

async function validateImage(input: Buffer): Promise<void> {
  await sharp(input, { animated: false, limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize(1, 1, { fit: "fill" })
    .jpeg({ quality: 1 })
    .toBuffer();
}

async function encodeImage(input: Buffer, spec: TierSpec, quality: number): Promise<string> {
  const out = await sharp(input, { animated: false, limitInputPixels: MAX_INPUT_PIXELS })
    .rotate()
    .resize({ width: spec.maxEdge, height: spec.maxEdge, fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality })
    .toBuffer();
  return out.toString("base64");
}

async function processAt(entry: Omit<NormalizedEntry, "position" | "size" | "terminal">, startPosition: number): Promise<ProcessResult> {
  const hash = createHash("sha256").update(entry.source).digest("base64url");
  for (let position = startPosition; position <= TERMINAL_POSITION; position += 1) {
    const spec = TIER_SPECS[position]!;
    const cacheKey = `${hash}:${entry.sourceMediaType}:${position}`;
    const cached = cacheGet(cacheKey);
    if (cached === "pass") return { kind: "pass", position, size: entry.sourceBase64.length };
    if (cached === "miss") continue;
    if (cached) return { kind: "encoded", position, data: cached.data, mediaType: cached.mediaType };

    if (PASSTHROUGH_MEDIA.has(entry.sourceMediaType)
      && entry.width <= spec.maxEdge
      && entry.height <= spec.maxEdge
      && entry.sourceBase64.length <= spec.hardCap) {
      try { await validateImage(entry.source); }
      catch { return { kind: "failed", position }; }
      cachePut(cacheKey, "pass");
      return { kind: "pass", position, size: entry.sourceBase64.length };
    }

    let last: string | undefined;
    try {
      for (const quality of spec.qualities) {
        last = await encodeImage(entry.source, spec, quality);
        if (last.length <= spec.hardCap) {
          const value = { data: last, mediaType: "image/jpeg" };
          cachePut(cacheKey, value);
          return { kind: "encoded", position, ...value };
        }
      }
    } catch {
      return { kind: "failed", position };
    }
    if (position === TERMINAL_POSITION && last) {
      const value = { data: last, mediaType: "image/jpeg" };
      cachePut(cacheKey, value);
      return { kind: "encoded", position, ...value };
    }
    cachePut(cacheKey, "miss");
  }
  return { kind: "failed", position: TERMINAL_POSITION };
}

function enforceLimits(messages: unknown[]): void {
  const refs = collectImageRefs(messages);
  const live = new Set<number>(refs.keys());

  for (let index = 0; index < refs.length; index += 1) {
    const base64 = refs[index]!.base64;
    if (base64 && base64.length > MAX_IMAGE_BASE64_LENGTH) {
      textify(refs[index]!, PER_IMAGE_TEXT);
      live.delete(index);
    }
  }

  // URL images cannot be dimension-checked. As in OpenCodex, keep such requests at
  // the conservative 20-image threshold so one unknown oversized image cannot 400 it.
  const hasUnknownDimensions = [...live].some((index) => refs[index]!.base64 === null);
  const countCap = hasUnknownDimensions ? MANY_IMAGE_THRESHOLD : MAX_IMAGES_PER_REQUEST;
  for (const index of [...live]) {
    if (live.size <= countCap) break;
    textify(refs[index]!, COUNT_TEXT);
    live.delete(index);
  }

  let total = 0;
  for (const index of live) total += refs[index]!.base64?.length ?? 0;
  for (const index of [...live]) {
    if (total <= TOTAL_IMAGE_BASE64_BUDGET) break;
    const base64 = refs[index]!.base64;
    if (!base64) continue;
    textify(refs[index]!, BYTE_BUDGET_TEXT);
    live.delete(index);
    total -= base64.length;
  }
}

export async function normalizeAnthropicImages(messages: unknown[]): Promise<void> {
  const refs = collectImageRefs(messages);
  if (!refs.length) return;
  const entries: Array<NormalizedEntry | null> = new Array(refs.length).fill(null);

  for (let index = 0; index < refs.length; index += 1) {
    const ref = refs[index]!;
    if (!ref.base64) continue;
    const newestFirstIndex = refs.length - 1 - index;
    if (newestFirstIndex >= MAX_IMAGES_PER_REQUEST) continue;
    if (ref.base64.length > MAX_INPUT_BASE64_LENGTH) {
      textify(ref, BOMB_TEXT);
      continue;
    }
    const source = Buffer.from(ref.base64, "base64");
    let metadata: sharp.Metadata;
    try { metadata = await sharp(source, { animated: false, limitInputPixels: MAX_INPUT_PIXELS }).metadata(); }
    catch {
      textify(ref, UNDECODABLE_TEXT);
      continue;
    }
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (!width || !height || width * height > MAX_INPUT_PIXELS) {
      textify(ref, BOMB_TEXT);
      continue;
    }
    const sourceEntry = { ref, source, sourceBase64: ref.base64, sourceMediaType: ref.mediaType, width, height };
    const result = await processAt(sourceEntry, initialPosition(newestFirstIndex));
    if (result.kind === "failed") {
      textify(ref, UNDECODABLE_TEXT);
      continue;
    }
    const size = result.kind === "pass" ? result.size : result.data.length;
    if (result.kind === "encoded") replaceImage(ref, result.data, result.mediaType);
    entries[index] = { ...sourceEntry, position: result.position, size, terminal: result.position >= TERMINAL_POSITION };
  }

  let total = entries.reduce((sum, entry) => sum + (entry?.size ?? 0), 0);
  while (total > TOTAL_IMAGE_BASE64_BUDGET) {
    const entry = entries.find((candidate): candidate is NormalizedEntry => Boolean(candidate && !candidate.terminal));
    if (!entry) break;
    const result = await processAt(entry, entry.position + 1);
    if (result.kind === "failed") {
      textify(entry.ref, UNDECODABLE_TEXT);
      total -= entry.size;
      entries[entries.indexOf(entry)] = null;
      continue;
    }
    const nextSize = result.kind === "pass" ? result.size : result.data.length;
    if (result.kind === "encoded") replaceImage(entry.ref, result.data, result.mediaType);
    total += nextSize - entry.size;
    entry.size = nextSize;
    entry.position = result.position;
    entry.terminal = result.position >= TERMINAL_POSITION;
  }

  enforceLimits(messages);
}

export function resetAnthropicImageCacheForTests(): void {
  normalizationCache.clear();
  normalizationCacheBytes = 0;
}
