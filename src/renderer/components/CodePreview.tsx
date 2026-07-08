import { Highlight, themes, type Language } from "prism-react-renderer";

const LANGUAGES: Record<string, Language> = {
  ts: "typescript", cts: "typescript", mts: "typescript", tsx: "tsx",
  js: "javascript", cjs: "javascript", mjs: "javascript", jsx: "jsx",
  json: "json", jsonc: "json", css: "css", scss: "css", html: "markup",
  md: "markdown", mdx: "markdown", py: "python", sh: "bash", bash: "bash",
  yaml: "yaml", yml: "yaml", sql: "sql", java: "java", go: "go", rust: "rust",
};

export function languageForPath(path: string): Language {
  return LANGUAGES[path.split(".").at(-1)?.toLowerCase() ?? ""] ?? "plain";
}

export { themes as prismThemes };

export function CodePreview({ path, code, wrap = false }: { path: string; code: string; wrap?: boolean }): React.JSX.Element {
  const language = languageForPath(path);
  return <Highlight theme={themes.vsDark} code={code.replace(/\n$/, "")} language={language}>
    {({ className, style, tokens, getLineProps, getTokenProps }) => <pre className={`file-code ${className}${wrap ? " wrap" : ""}`} style={style}>{tokens.map((line, index) => <div {...getLineProps({ line })} key={index}><span className="line-number">{index + 1}</span>{line.map((token, tokenIndex) => <span {...getTokenProps({ token })} key={tokenIndex} />)}</div>)}</pre>}
  </Highlight>;
}
