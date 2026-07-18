export const OCX_REASONING_PREFIX = "ocxr1:";

export function encodeReasoningEnvelope(value: { sig?: string; txt?: string; red?: string[] }): string {
  return OCX_REASONING_PREFIX + Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}
