import { type ReactNode, isValidElement, memo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";

function nodeText(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  return isValidElement<{ children?: ReactNode }>(node) ? nodeText(node.props.children) : "";
}

// react-markdown renders a fenced ```lang block as <pre><code class="language-lang">.
// We override `pre` (not `code`) so we can wrap it with a header + copy button;
// pull the language back out of the child <code>'s className.
function languageOf(children: ReactNode): string {
  const child = Array.isArray(children) ? children[0] : children;
  if (isValidElement<{ className?: string }>(child)) {
    const match = /language-(\w+)/.exec(child.props.className ?? "");
    if (match) return match[1];
  }
  return "";
}

function CodeBlock({ children }: { children: ReactNode }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const lang = languageOf(children);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard?.writeText(nodeText(children));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard unavailable (insecure context, permission denied) - no-op
    }
  };
  return (
    <div className="markdown-code">
      <div className="markdown-code-head">
        <span>{lang || "code"}</span>
        <button type="button" onClick={() => void copy()} aria-label="코드 복사">
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

// Chat text/tool output isn't authored markdown by a human - it's model output
// that may or may not use markdown syntax. Render it as markdown (so fenced
// code, lists, tables, bold/italic show up formatted) but keep it self
// contained: no raw HTML passthrough, no devil-file:// local-path links (those
// only make sense against the desktop app's own filesystem, not a phone).
export const MobileMarkdown = memo(function MobileMarkdown({ text }: { text: string }): React.JSX.Element {
  return (
    <div className="markdown-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => (/^(https?:|mailto:)/i.test(url) ? url : "")}
        components={{
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          table: ({ children }) => <div className="markdown-table-wrap"><table>{children}</table></div>,
          a: ({ href, children }) => href
            ? <a href={href} target="_blank" rel="noreferrer">{children}</a>
            : <span>{children}</span>,
          img: ({ alt }) => <span className="markdown-image-disabled">[이미지: {alt || "첨부"}]</span>,
        }}
      >{text}</ReactMarkdown>
    </div>
  );
});
