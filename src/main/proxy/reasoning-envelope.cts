export const OCX_REASONING_PREFIX = "ocxr1:";

export function encodeReasoningEnvelope(value: { sig?: string; txt?: string; red?: string[] }): string {
  return OCX_REASONING_PREFIX + Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

export function decodeReasoningEnvelope(encryptedContent: string): { sig?: string; txt?: string; red?: string[] } | null {
  if (!encryptedContent.startsWith(OCX_REASONING_PREFIX)) return null;
  try {
    const value = JSON.parse(Buffer.from(encryptedContent.slice(OCX_REASONING_PREFIX.length), "base64").toString("utf8")) as Record<string, unknown>;
    return {
      ...(typeof value.sig === "string" ? { sig: value.sig } : {}),
      ...(typeof value.txt === "string" ? { txt: value.txt } : {}),
      ...(Array.isArray(value.red) ? { red: value.red.filter((item): item is string => typeof item === "string") } : {}),
    };
  } catch { return null; }
}
