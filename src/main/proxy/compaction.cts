// Responses remote-compaction compatibility, adapted from OpenCodex (MIT).
export const OCX_COMPACTION_PREFIX = "ocx1:";

export const COMPACT_PROMPT = `You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.

Include:
- Current progress and key decisions made
- Important context, constraints, or user preferences
- What remains to be done (clear next steps)
- Any critical data, examples, or references needed to continue

Be concise, structured, and focused on helping the next LLM seamlessly continue the work.`;

export const SUMMARY_PREFIX = "Another language model started to solve this problem and produced a summary of its thinking process. You also have access to the state of the tools that were used by that language model. Use this to build on the work that has already been done and avoid duplicating work. Here is the summary produced by the other language model, use the information in this summary to assist with your own analysis:";
export const OPAQUE_COMPACTION_NOTE = "[earlier conversation was compacted; the summary is stored in a format this model cannot read]";

export function encodeCompactionSummary(summary: string): string {
  return OCX_COMPACTION_PREFIX + Buffer.from(summary, "utf8").toString("base64");
}

export function decodeCompactionSummary(encryptedContent: string): string | null {
  if (!encryptedContent.startsWith(OCX_COMPACTION_PREFIX)) return null;
  try { return Buffer.from(encryptedContent.slice(OCX_COMPACTION_PREFIX.length), "base64").toString("utf8"); }
  catch { return null; }
}

export function compactionItemToText(encryptedContent: string | undefined): string {
  const decoded = typeof encryptedContent === "string" ? decodeCompactionSummary(encryptedContent) : null;
  return decoded ? `${SUMMARY_PREFIX}\n\n${decoded}` : OPAQUE_COMPACTION_NOTE;
}

const COMPACT_V1_RETAINED_CHAR_BUDGET = 20_000 * 4;

export function extractCompactUserMessages(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const out: string[] = [];
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const rec = item as { type?: string; role?: string; content?: unknown };
    if (rec.type !== undefined && rec.type !== "message") continue;
    if (rec.role !== "user") continue;
    let value = "";
    if (typeof rec.content === "string") value = rec.content;
    else if (Array.isArray(rec.content)) value = rec.content.map((block) => {
      if (!block || typeof block !== "object") return "";
      const part = block as { type?: string; text?: string };
      return (part.type === "input_text" || part.type === "text") && typeof part.text === "string" ? part.text : "";
    }).join("");
    if (value.trim()) out.push(value);
  }
  return out;
}

function userMessage(text: string): Record<string, unknown> {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

export function buildCompactV1Output(userMessages: string[], summary: string): Record<string, unknown>[] {
  const retained: string[] = [];
  let remaining = COMPACT_V1_RETAINED_CHAR_BUDGET;
  for (let index = userMessages.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const message = userMessages[index] ?? "";
    if (message.length <= remaining) {
      retained.push(message);
      remaining -= message.length;
    } else {
      retained.push(message.slice(message.length - remaining));
      break;
    }
  }
  retained.reverse();
  const summaryText = summary.trim() ? `${SUMMARY_PREFIX}\n${summary}` : "(no summary available)";
  return [...retained.map(userMessage), userMessage(summaryText)];
}
