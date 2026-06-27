import { useState } from "react";
import type { ThreadAttachment } from "../../shared/contracts";

const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|avif|heic|heif)$/i;
const TEXT_RE = /\.(txt|md|markdown|json|csv|tsv|ya?ml|toml|log|xml|html|css|tsx?|jsx?|cjs|mjs|py|rb|go|rs|java|kt|swift|sh|zsh|bash|sql)$/i;

const isImage = (file: File, path: string): boolean => file.type.startsWith("image/") || IMAGE_RE.test(path);
const isText = (file: File, path: string): boolean => file.type.startsWith("text/") || TEXT_RE.test(path);

function readAs(file: File, mode: "data" | "text"): Promise<string | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    if (mode === "data") reader.readAsDataURL(file); else reader.readAsText(file);
  });
}

const textToDataUrl = (text: string): string => `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;

// Shared attachment state for composer-style inputs (image/file paste, drop,
// picker, long-text-as-file). Images/text resolve to a data URL so they render
// and can be sent to the model.
export function useAttachments(): {
  attachments: ThreadAttachment[];
  ready: boolean;
  addFiles: (files: FileList | File[]) => void;
  addText: (text: string) => void;
  remove: (key: string) => void;
  clear: () => void;
} {
  const [attachments, setAttachments] = useState<ThreadAttachment[]>([]);
  const ready = attachments.every((item) => item.kind !== "image" || Boolean(item.url));

  const addFiles = (files: FileList | File[]): void => {
    const selected = Array.from(files);
    if (!selected.length) return;
    const next = selected.map((file) => {
      const path = window.devilCodex.getFilePath(file) || file.name || `paste-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      return { file, path, attachment: { path, name: file.name || path.split(/[\\/]/).pop() || path, kind: isImage(file, path) ? "image" as const : "file" as const, mime: file.type || undefined, size: file.size } };
    });
    setAttachments((current) => [...current, ...next.map((n) => n.attachment).filter((item) => !current.some((existing) => existing.path === item.path))]);
    void Promise.all(next.map(async ({ file, path, attachment }) => {
      if (attachment.kind === "image") {
        const local = await window.devilCodex.previewLocalImage({ path }).catch(() => null);
        const dataUrl = local ?? (await readAs(file, "data"));
        if (dataUrl) setAttachments((current) => current.map((e) => e.path === path ? { ...e, url: dataUrl } : e));
      } else if (isText(file, path)) {
        const content = await readAs(file, "text");
        if (content) setAttachments((current) => current.map((e) => e.path === path ? { ...e, content, url: textToDataUrl(content) } : e));
      }
    }));
  };

  const addText = (text: string): void => {
    const name = `pasted-text-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-")}.txt`;
    setAttachments((current) => [...current, { path: name, name, kind: "file", mime: "text/plain", size: new TextEncoder().encode(text).length, content: text, url: textToDataUrl(text) }]);
  };

  const remove = (key: string): void => setAttachments((current) => current.filter((item) => (item.path ?? item.url ?? item.name) !== key));
  const clear = (): void => setAttachments([]);

  return { attachments, ready, addFiles, addText, remove, clear };
}
