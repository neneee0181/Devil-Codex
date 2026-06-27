import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Download, FileText, Image as ImageIcon, X } from "lucide-react";
import type { ThreadAttachment } from "../../shared/contracts";

type AttachmentAction = {
  attachment: ThreadAttachment;
  src?: string;
};

function readableSize(size?: number): string {
  if (!size || size < 1) return "";
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)}KB`;
  return `${(size / 1024 / 1024).toFixed(1)}MB`;
}

function downloadUrl(src: string, name: string): void {
  const link = document.createElement("a");
  link.href = src;
  link.download = name || "attachment";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

async function copyImage(src: string): Promise<boolean> {
  try {
    const response = await fetch(src);
    const blob = await response.blob();
    const ClipboardItemCtor = globalThis.ClipboardItem;
    if (!navigator.clipboard?.write || !ClipboardItemCtor) return false;
    await navigator.clipboard.write([new ClipboardItemCtor({ [blob.type || "image/png"]: blob })]);
    return true;
  } catch {
    return false;
  }
}

export function AttachmentImageViewer({ viewer, onClose }: { viewer: AttachmentAction; onClose: () => void }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return createPortal(
    <div className="attachment-viewer-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="attachment-viewer" onClick={(event) => event.stopPropagation()}>
        <header>
          <span>{viewer.attachment.name}</span>
          <div>
            {viewer.src && (
              <button type="button" onClick={() => downloadUrl(viewer.src ?? "", viewer.attachment.name)} title="이미지 저장">
                <Download size={17} />저장
              </button>
            )}
            {viewer.src && (
              <button type="button" onClick={() => void copyImage(viewer.src ?? "").then((ok) => { setCopied(ok); window.setTimeout(() => setCopied(false), 1200); })} title="이미지 복사">
                {copied ? <Check size={17} /> : <Copy size={17} />}{copied ? "복사됨" : "복사"}
              </button>
            )}
            <button type="button" onClick={onClose} title="닫기"><X size={18} /></button>
          </div>
        </header>
        {viewer.src && <img src={viewer.src} alt={viewer.attachment.name} />}
      </div>
    </div>,
    document.body,
  );
}

function ImageThumb({ item, onOpen }: { item: ThreadAttachment; onOpen: (input: AttachmentAction) => void }): React.JSX.Element {
  const [src, setSrc] = useState(item.url ?? "");
  const [loaded, setLoaded] = useState(Boolean(item.url));

  useEffect(() => {
    let live = true;
    setSrc(item.url ?? "");
    setLoaded(Boolean(item.url));
    if (item.url || !item.path) return () => { live = false; };
    void window.devilCodex.previewLocalImage({ path: item.path }).then((data) => {
      if (!live) return;
      setSrc(data ?? "");
      setLoaded(true);
    }).catch(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, [item.path, item.url]);

  return (
    <button type="button" className="attachment-card image" title={item.path ?? item.name} onClick={() => src && onOpen({ attachment: item, src })}>
      {src ? <img src={src} alt={item.name} /> : <span className="attachment-card-placeholder"><ImageIcon size={19} />{loaded ? "이미지 없음" : "불러오는 중"}</span>}
    </button>
  );
}

export function AttachmentGallery({
  attachments,
  align = "start",
  onRemove,
}: {
  attachments: ThreadAttachment[];
  align?: "start" | "end";
  onRemove?: (path: string) => void;
}): React.JSX.Element | null {
  const [viewer, setViewer] = useState<AttachmentAction | null>(null);
  if (!attachments.length) return null;

  const openFile = (item: ThreadAttachment): void => {
    if (item.url) downloadUrl(item.url, item.name);
  };

  const closeViewer = (): void => {
    setViewer(null);
  };

  return (
    <>
      <div className={`attachment-gallery ${align === "end" ? "end" : ""}`}>
        {attachments.map((item, index) => {
          const key = `${item.path ?? item.url ?? item.name}-${index}`;
          const removeKey = item.path ?? item.url ?? item.name;
          return (
            <div className="attachment-shell" key={key}>
              {item.kind === "image" ? (
                <ImageThumb item={item} onOpen={setViewer} />
              ) : (
                <button type="button" className="attachment-card file" title={item.path ?? item.name} onClick={() => openFile(item)}>
                  <FileText size={18} />
                  <span>
                    <strong>{item.name}</strong>
                    {(item.mime || item.size) && <small>{[item.mime, readableSize(item.size)].filter(Boolean).join(" · ")}</small>}
                  </span>
                </button>
              )}
              {onRemove && (
                <button type="button" className="attachment-remove" aria-label={`${item.name} 첨부 제거`} onClick={(event) => { event.stopPropagation(); onRemove(removeKey); }}>
                  <X size={14} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      {viewer && <AttachmentImageViewer viewer={viewer} onClose={closeViewer} />}
    </>
  );
}
