// Spawn/inter-agent payload compatibility, adapted from OpenCodex (MIT).
function looksLikeBackendCiphertext(payload: string): boolean {
  return payload.length >= 64 && /^[A-Za-z0-9+/=_-]+$/.test(payload);
}

const FERNET_TOKEN_RUN = /gAAAA[A-Za-z0-9_-]{60,}={0,2}/g;

function encryptedSlotParts(payload: string): Array<Record<string, string>> {
  const parts: Array<Record<string, string>> = [];
  let last = 0;
  for (const match of payload.matchAll(FERNET_TOKEN_RUN)) {
    const index = match.index ?? 0;
    const before = payload.slice(last, index);
    if (before.trim()) parts.push({ type: "input_text", text: before });
    parts.push({ type: "encrypted_content", encrypted_content: match[0] });
    last = index + match[0].length;
  }
  const rest = payload.slice(last);
  if (rest.trim()) parts.push({ type: "input_text", text: rest });
  return parts.length ? parts : [{ type: "input_text", text: payload }];
}

function hasEncryptedContentPart(content: unknown): boolean {
  return Array.isArray(content) && content.some((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "encrypted_content");
}

export function sanitizeEncryptedContentInPlace(input: unknown): number {
  if (!Array.isArray(input)) return 0;
  let rewritten = 0;
  const visit = (node: unknown): number => {
    const before = rewritten;
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        const child = node[index] as unknown;
        if (child && typeof child === "object" && (child as { type?: unknown }).type === "encrypted_content" && typeof (child as { encrypted_content?: unknown }).encrypted_content === "string") {
          const payload = (child as { encrypted_content: string }).encrypted_content;
          if (!looksLikeBackendCiphertext(payload)) {
            const parts = encryptedSlotParts(payload);
            node.splice(index, 1, ...parts);
            index += parts.length - 1;
            rewritten += 1;
            continue;
          }
        }
        const childRewrites = visit(child);
        if (childRewrites > 0 && child && typeof child === "object" && (child as { type?: unknown }).type === "agent_message" && !hasEncryptedContentPart((child as { content?: unknown }).content)) {
          const message = child as { type: string; role?: string; id?: unknown; author?: unknown; recipient?: unknown };
          message.type = "message";
          message.role = "user";
          delete message.id;
          delete message.author;
          delete message.recipient;
        }
      }
      return rewritten - before;
    }
    if (node && typeof node === "object") for (const value of Object.values(node)) visit(value);
    return rewritten - before;
  };
  visit(input);
  return rewritten;
}
