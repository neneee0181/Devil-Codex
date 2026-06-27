import { type ReactNode, isValidElement, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
import { AttachmentImageViewer } from "./AttachmentCards";

function nodeText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  return isValidElement<{ children?: ReactNode }>(node) ? nodeText(node.props.children) : "";
}

function CodeBlock({ children }: { children: ReactNode }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    await navigator.clipboard?.writeText(nodeText(children));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return <div className="markdown-code"><button type="button" onClick={() => void copy()} aria-label="코드 복사">{copied ? <Check size={15} /> : <Copy size={15} />}</button><pre>{children}</pre></div>;
}

function richMarkdown(text: string): string {
  let fenced = false;
  return text.split("\n").map((line) => {
    if (line.trimStart().startsWith("```")) { fenced = !fenced; return line; }
    if (fenced || line.includes("](")) return line;
    if (line.trim() === "첨부 파일:") return "";
    const image = line.replace(/((?:\/[\w.@%+~ -]+)+\.(?:png|jpe?g|gif|webp|svg))/gi, (path) => `![${path.split("/").at(-1)}](devil-image:${encodeURIComponent(path)})`);
    if (image !== line) return image;
    return line.replace(/\b((?:[\w.@+-]+[\\/])*[\w.@+-]+\.(?:tsx?|jsx?|css|json|md|cjs|mjs|py|go|rs|java|kt|swift|html|ya?ml|toml|sql|sh))\b/g, (path) => `[${path}](devil-file:${encodeURIComponent(path)})`);
  }).join("\n");
}

export function LocalImage({ path, onOpen }: { path: string; onOpen: (src: string, name: string) => void }): React.JSX.Element {
  const [src, setSrc] = useState("");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    setSrc("");
    setLoaded(false);
    void window.devilCodex.previewLocalImage({ path }).then((data) => {
      if (!live) return;
      setSrc(data ?? "");
      setLoaded(true);
    }).catch(() => { if (live) setLoaded(true); });
    return () => { live = false; };
  }, [path]);
  const name = path.split("/").at(-1) ?? "첨부 이미지";
  if (src) return <button type="button" className="markdown-image-button" onClick={() => onOpen(src, name)}><img className="markdown-image" src={src} alt={name} /></button>;
  return <span className="markdown-image-loading">{loaded ? "이미지를 찾을 수 없습니다" : "이미지 불러오는 중…"}</span>;
}

export function MarkdownContent({ text, onOpenFile }: { text: string; onOpenFile?: (path: string) => void }): React.JSX.Element {
  const [viewer, setViewer] = useState<{ src: string; name: string } | null>(null);
  const openImage = (src: string, name: string): void => setViewer({ src, name });
  return <>
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={(url) => url}
      components={{
        pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
        img: ({ src, alt }) => {
          if (!src) return null;
          if (src.startsWith("devil-image:")) return <LocalImage path={decodeURIComponent(src.slice(12))} onOpen={openImage} />;
          const name = alt || src.split(/[/?#]/).filter(Boolean).at(-1) || "이미지";
          return <button type="button" className="markdown-image-button" onClick={() => openImage(src, name)}><img className="markdown-image" src={src} alt={name} /></button>;
        },
        a: ({ href, children }) => {
          const external = /^(https?:|mailto:|#)/i.test(href ?? "");
          const path = href?.startsWith("devil-file:") ? decodeURIComponent(href.slice(11)) : decodeURIComponent(href ?? "");
          return external ? <a href={href} target="_blank" rel="noreferrer">{children}</a> : <button type="button" className="markdown-file-link" onClick={() => onOpenFile?.(path.replace(/^file:\/\//, ""))}>{children}</button>;
        },
      }}
    >{richMarkdown(text)}</ReactMarkdown>
    {viewer && <AttachmentImageViewer viewer={{ attachment: { name: viewer.name, kind: "image", url: viewer.src }, src: viewer.src }} onClose={() => setViewer(null)} />}
  </>;
}
