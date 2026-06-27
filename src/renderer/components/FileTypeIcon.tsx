import { Atom, Braces, File, Hash } from "lucide-react";

export function FileTypeIcon({ name }: { name: string }): React.JSX.Element {
  const extension = name.split(".").at(-1)?.toLowerCase();
  if (["tsx", "jsx"].includes(extension ?? "")) return <Atom className="file-type react" size={16} />;
  if (["ts", "cts", "mts"].includes(extension ?? "")) return <span className="file-type badge ts">TS</span>;
  if (["js", "cjs", "mjs"].includes(extension ?? "")) return <span className="file-type badge js">JS</span>;
  if (extension === "css") return <span className="file-type badge css">CSS</span>;
  if (["json", "jsonc"].includes(extension ?? "")) return <Braces className="file-type json" size={16} />;
  if (["md", "mdx"].includes(extension ?? "")) return <span className="file-type badge md">M↓</span>;
  if (["html", "htm"].includes(extension ?? "")) return <Hash className="file-type html" size={16} />;
  return <File className="file-type" size={15} />;
}
