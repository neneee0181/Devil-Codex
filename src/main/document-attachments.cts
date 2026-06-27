import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { inflateRawSync, inflateSync } from "node:zlib";
import type { ThreadAttachment } from "./contracts.cjs";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_CHARS_PER_FILE = 40_000;
const MAX_TOTAL_CHARS = 120_000;

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".json", ".jsonl", ".csv", ".tsv", ".yaml", ".yml", ".toml",
  ".log", ".xml", ".html", ".css", ".ts", ".tsx", ".js", ".jsx", ".cjs", ".mjs", ".py",
  ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".sh", ".zsh", ".bash", ".sql",
]);

type ExtractedDocument = {
  text: string;
  warning?: string;
};

function truncateText(text: string, limit = MAX_CHARS_PER_FILE): ExtractedDocument {
  const cleaned = text.replace(/\r\n/g, "\n").replace(/\u0000/g, "").trim();
  if (cleaned.length <= limit) return { text: cleaned };
  return {
    text: cleaned.slice(0, limit),
    warning: `문서가 길어서 앞 ${limit.toLocaleString()}자만 모델 입력에 포함했습니다.`,
  };
}

function stripXml(value: string): string {
  return value
    .replace(/<w:tab\/>/g, "\t")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<\/w:tr>/g, "\n")
    .replace(/<\/w:tc>/g, "\t")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function stripRtf(value: string): string {
  return value
    .replace(/\\'[0-9a-fA-F]{2}/g, " ")
    .replace(/\\par[d]?/g, "\n")
    .replace(/\\tab/g, "\t")
    .replace(/\\[a-zA-Z]+-?\d* ?/g, "")
    .replace(/[{}]/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const signature = 0x06054b50;
  for (let offset = buffer.length - 22; offset >= 0 && offset >= buffer.length - 66_000; offset -= 1) {
    if (buffer.readUInt32LE(offset) === signature) return offset;
  }
  return -1;
}

function unzipEntries(buffer: Buffer): Map<string, Buffer> {
  const end = findEndOfCentralDirectory(buffer);
  if (end < 0) return new Map();
  const entryCount = buffer.readUInt16LE(end + 10);
  const centralOffset = buffer.readUInt32LE(end + 16);
  const entries = new Map<string, Buffer>();
  let cursor = centralOffset;
  for (let index = 0; index < entryCount && cursor < buffer.length; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.slice(cursor + 46, cursor + 46 + nameLength).toString("utf8");
    cursor += 46 + nameLength + extraLength + commentLength;

    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) continue;
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.slice(dataStart, dataStart + compressedSize);
    if (method === 0) entries.set(name, data);
    else if (method === 8) {
      try { entries.set(name, inflateRawSync(data, { finishFlush: 2 })); } catch { /* ignore bad zip entry */ }
    }
    if (uncompressedSize === 0 && !entries.has(name)) entries.set(name, Buffer.alloc(0));
  }
  return entries;
}

function extractDocxText(buffer: Buffer): ExtractedDocument {
  const entries = unzipEntries(buffer);
  const names = [
    "word/document.xml",
    ...Array.from(entries.keys()).filter((name) => /^word\/(header|footer)\d+\.xml$/.test(name)).sort(),
  ];
  const text = names.flatMap((name) => {
    const entry = entries.get(name);
    return entry ? [stripXml(entry.toString("utf8"))] : [];
  }).join("\n").replace(/\n{3,}/g, "\n\n");
  if (!text.trim()) return { text: "", warning: "DOCX 본문을 찾지 못했습니다." };
  return truncateText(text);
}

function pdfLiteral(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")")
    .replace(/\\\\/g, "\\");
}

function utf16BeHex(hex: string): string {
  const buffer = Buffer.from(hex, "hex");
  let output = "";
  for (let index = 0; index + 1 < buffer.length; index += 2) {
    output += String.fromCharCode(buffer.readUInt16BE(index));
  }
  return output;
}

function extractPdfText(buffer: Buffer): ExtractedDocument {
  const chunks: string[] = [];
  const source = buffer.toString("latin1");
  const streamPattern = /<<(.*?)>>\s*stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let match: RegExpExecArray | null;
  while ((match = streamPattern.exec(source))) {
    const dictionary = match[1] ?? "";
    const raw = Buffer.from(match[2] ?? "", "latin1");
    if (!/FlateDecode|ASCIIHexDecode|ASCII85Decode|LZWDecode|DCTDecode|JPXDecode|\/Filter/.test(dictionary)) {
      chunks.push(raw.toString("latin1"));
      continue;
    }
    if (/FlateDecode/.test(dictionary)) {
      try { chunks.push(inflateSync(raw).toString("latin1")); } catch { /* ignore compressed stream */ }
    }
  }
  chunks.push(source);
  const text = chunks.join("\n")
    .replace(/<([0-9a-fA-F]{4,})>/g, (_all, hex: string) => {
      try { return utf16BeHex(hex); } catch { return " "; }
    })
    .replace(/\((?:\\.|[^\\)])*\)\s*Tj/g, (token) => pdfLiteral(token.slice(1, token.lastIndexOf(")"))))
    .replace(/\[(.*?)\]\s*TJ/gs, (_all, body: string) => Array.from(body.matchAll(/\((?:\\.|[^\\)])*\)/g)).map((item) => pdfLiteral(item[0].slice(1, -1))).join(""))
    .replace(/\\\d{3}/g, " ")
    .replace(/[^\S\n]+/g, " ")
    .replace(/\n{3,}/g, "\n\n");
  const cleaned = text.split("\n").map((line) => line.trim()).filter((line) => /[A-Za-z0-9가-힣]/.test(line)).join("\n");
  if (!cleaned.trim()) return { text: "", warning: "PDF 텍스트를 추출하지 못했습니다. 스캔 PDF이거나 복잡한 인코딩일 수 있습니다." };
  const result = truncateText(cleaned);
  return {
    ...result,
    warning: result.warning ?? "PDF 추출은 기본 내장 파서의 best-effort 결과입니다. 복잡한 PDF는 일부 텍스트가 누락될 수 있습니다.",
  };
}

async function extractDocument(attachment: ThreadAttachment): Promise<ThreadAttachment> {
  if (attachment.kind !== "file" || attachment.content || !attachment.path) return attachment;
  try {
    const info = await stat(attachment.path);
    if (!info.isFile()) return { ...attachment, content: "[첨부 파일 본문 추출 실패: 파일이 아닙니다.]" };
    if (info.size > MAX_FILE_BYTES) return { ...attachment, content: `[첨부 파일 본문 추출 생략: ${MAX_FILE_BYTES / 1024 / 1024}MB보다 큽니다.]` };
    const buffer = await readFile(attachment.path);
    const ext = extname(attachment.path || attachment.name).toLowerCase();
    let extracted: ExtractedDocument | undefined;
    if (TEXT_EXTENSIONS.has(ext) || attachment.mime?.startsWith("text/")) extracted = truncateText(buffer.toString("utf8"));
    else if (ext === ".docx") extracted = extractDocxText(buffer);
    else if (ext === ".pdf") extracted = extractPdfText(buffer);
    else if (ext === ".rtf") extracted = truncateText(stripRtf(buffer.toString("utf8")));
    else extracted = { text: "", warning: `지원하지 않는 문서 형식입니다: ${ext || attachment.mime || "unknown"}` };
    const content = [extracted.text, extracted.warning ? `\n[주의] ${extracted.warning}` : ""].join("").trim();
    return content ? { ...attachment, content } : { ...attachment, content: `[첨부 파일 본문 추출 실패: ${extracted.warning ?? "내용이 비어 있습니다."}]` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ...attachment, content: `[첨부 파일 본문 추출 실패: ${detail}]` };
  }
}

export async function enrichDocumentAttachments(attachments?: ThreadAttachment[]): Promise<{ attachments: ThreadAttachment[]; context: string }> {
  const source = attachments ?? [];
  const enriched = await Promise.all(source.map(extractDocument));
  let remaining = MAX_TOTAL_CHARS;
  const lines: string[] = [];
  for (const [index, item] of enriched.entries()) {
    if (item.kind !== "file" || !item.content) continue;
    if (source[index]?.content) continue;
    const slice = item.content.slice(0, remaining);
    remaining -= slice.length;
    lines.push("", `첨부 문서 ${item.name} 추출 내용:`, "```text", slice, "```");
    if (remaining <= 0) {
      lines.push("", `[첨부 문서 추출은 총 ${MAX_TOTAL_CHARS.toLocaleString()}자까지만 모델 입력에 포함했습니다.]`);
      break;
    }
  }
  return { attachments: enriched, context: lines.length ? `\n\n${lines.join("\n")}` : "" };
}
