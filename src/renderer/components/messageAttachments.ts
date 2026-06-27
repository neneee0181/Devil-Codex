const IMAGE_PATH = /((?:\/[\w.@%+~ -]+)+\.(?:png|jpe?g|gif|webp|svg))/gi;

export function splitMessageImages(text: string): { text: string; images: string[] } {
  const images: string[] = [];
  let skippingAttachmentBlock = false;
  const lines = text.split("\n").filter((line) => {
    const matches = [...line.matchAll(IMAGE_PATH)].map((match) => match[1]);
    if (matches.length) { images.push(...matches); return false; }
    const value = line.trim();
    if (value === "첨부 파일:") { skippingAttachmentBlock = true; return false; }
    if (skippingAttachmentBlock && value.startsWith("- ")) return false;
    skippingAttachmentBlock = false;
    if (/^#+\s*Files mentioned by the user:?$/i.test(value)) return false;
    if (/^##\s*codex-clipboard-.+\.(?:png|jpe?g|gif|webp|svg):?$/i.test(value)) return false;
    if (/^##\s*My request for Codex:?$/i.test(value)) return false;
    return true;
  });
  return { text: lines.join("\n").replace(/^\s+|\s+$/g, ""), images: [...new Set(images)] };
}
