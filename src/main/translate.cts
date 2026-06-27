// Free, key-less translation used to show the model's English output in the
// user's language on demand. Calls the public Google endpoint — the same
// backend Chrome's built-in "Translate" uses — from the main process so there's
// no CORS limit and no API key. Fenced code blocks are passed through verbatim
// so identifiers, paths, and commands never get mangled.

const ENDPOINT = "https://translate.googleapis.com/translate_a/single";
const MAX_CHARS = 4500;

type Segment = { text: string; code: boolean };

// Split a markdown string into prose vs. fenced code-block segments. Only prose
// is translated; code blocks are emitted unchanged.
function splitCodeFromProse(text: string): Segment[] {
  const parts: Segment[] = [];
  const fence = /```[\s\S]*?```/g;
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = fence.exec(text))) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index), code: false });
    parts.push({ text: match[0], code: true });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), code: false });
  return parts.length ? parts : [{ text, code: false }];
}

// The endpoint caps query length, so break long prose on line boundaries.
function chunk(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (current && (current.length + line.length + 1) > max) { out.push(current); current = ""; }
    current += current ? `\n${line}` : line;
    while (current.length > max) { out.push(current.slice(0, max)); current = current.slice(max); }
  }
  if (current) out.push(current);
  return out;
}

async function callGoogle(text: string, from: string, to: string): Promise<string> {
  const url = `${ENDPOINT}?client=gtx&sl=${encodeURIComponent(from)}&tl=${encodeURIComponent(to)}&dt=t&q=${encodeURIComponent(text)}`;
  const response = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" } });
  if (!response.ok) throw new Error(`번역 서버 오류 (HTTP ${response.status})`);
  const data = (await response.json()) as unknown;
  const sentences = Array.isArray(data) && Array.isArray(data[0]) ? (data[0] as unknown[]) : [];
  return sentences.map((entry) => (Array.isArray(entry) && typeof entry[0] === "string" ? entry[0] : "")).join("");
}

async function translateProse(text: string, from: string, to: string): Promise<string> {
  if (!text.trim()) return text;
  let result = "";
  for (const part of chunk(text, MAX_CHARS)) result += await callGoogle(part, from, to);
  return result;
}

export async function translateText(input: { text: string; to?: string; from?: string }): Promise<string> {
  const to = input.to || "ko";
  const from = input.from || "auto";
  if (!input.text.trim()) return input.text;
  const segments = splitCodeFromProse(input.text);
  const out: string[] = [];
  for (const segment of segments) out.push(segment.code ? segment.text : await translateProse(segment.text, from, to));
  return out.join("");
}
