export type DiffLineKind = "add" | "remove" | "context" | "hunk" | "meta";

export interface ParsedDiffLine {
  id: number;
  text: string;
  kind: DiffLineKind;
  oldLine?: number;
  newLine?: number;
  hunk?: string;
}

export type SplitDiffRow = { id: string; old?: ParsedDiffLine; next?: ParsedDiffLine; hunk?: ParsedDiffLine };

export function parseUnifiedDiff(text: string): ParsedDiffLine[] {
  let oldLine = 0;
  let newLine = 0;
  let currentHunk: string | undefined;
  return text.split("\n").filter((line, index, lines) => line || index < lines.length - 1).map((line, id) => {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      currentHunk = line;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      return { id, text: line, kind: "hunk" as const, hunk: currentHunk };
    }
    if (line.startsWith("+") && !line.startsWith("+++")) return { id, text: line, kind: "add" as const, newLine: newLine++, hunk: currentHunk };
    if (line.startsWith("-") && !line.startsWith("---")) return { id, text: line, kind: "remove" as const, oldLine: oldLine++, hunk: currentHunk };
    if (line.startsWith(" ")) return { id, text: line, kind: "context" as const, oldLine: oldLine++, newLine: newLine++, hunk: currentHunk };
    return { id, text: line, kind: "meta" as const };
  });
}

export function toSplitDiffRows(lines: ParsedDiffLine[]): SplitDiffRow[] {
  const rows: SplitDiffRow[] = [];
  let removed: ParsedDiffLine[] = [];
  const flushRemoved = (): void => {
    for (const line of removed) rows.push({ id: `remove-${line.id}`, old: line });
    removed = [];
  };
  for (const line of lines) {
    if (line.kind === "meta") continue;
    if (line.kind === "hunk") { flushRemoved(); rows.push({ id: `hunk-${line.id}`, hunk: line }); continue; }
    if (line.kind === "remove") { removed.push(line); continue; }
    if (line.kind === "add") {
      const old = removed.shift();
      rows.push({ id: `change-${old?.id ?? ""}-${line.id}`, old, next: line });
      continue;
    }
    flushRemoved();
    rows.push({ id: `same-${line.id}`, old: line, next: line });
  }
  flushRemoved();
  return rows;
}
