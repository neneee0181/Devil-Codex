import { useRef } from "react";
import { Highlight, themes } from "prism-react-renderer";
import { languageForPath } from "./CodePreview";

// A lightweight syntax-highlighted editor: a transparent <textarea> is layered
// over a Prism highlight <pre>. The textarea owns the caret and input; the pre
// paints the colors. Both share identical typography/padding (see .code-editor
// CSS) so glyphs line up exactly. Editing therefore keeps the same per-language
// colors the read-only preview shows.
export function CodeEditor({ path, value, onChange, onKeyDown }: {
  path: string;
  value: string;
  onChange: (next: string) => void;
  onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
}): React.JSX.Element {
  const highlightRef = useRef<HTMLPreElement>(null);
  const language = languageForPath(path);
  // Trailing newline: Prism drops a final empty line, so pad it so the painted
  // text keeps pace with the textarea's own trailing blank line.
  const painted = value.endsWith("\n") ? `${value}​` : value;
  return <div className="code-editor">
    <Highlight theme={themes.vsDark} code={painted} language={language}>
      {({ style, tokens, getLineProps, getTokenProps }) => (
        <pre ref={highlightRef} className="code-editor-layer" aria-hidden="true" style={style}>
          {tokens.map((line, index) => <div {...getLineProps({ line })} key={index}>{line.map((token, tokenIndex) => <span {...getTokenProps({ token })} key={tokenIndex} />)}</div>)}
        </pre>
      )}
    </Highlight>
    <textarea
      className="code-editor-input"
      spellCheck={false}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      onScroll={(event) => { const el = highlightRef.current; if (el) { el.scrollTop = event.currentTarget.scrollTop; el.scrollLeft = event.currentTarget.scrollLeft; } }}
    />
  </div>;
}
