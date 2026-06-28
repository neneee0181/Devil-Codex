export type CodexDesktopTheme = "dark" | "light";

function desktopSectionBounds(source: string): { headerEnd: number; sectionEnd: number; body: string } | undefined {
  const header = source.match(/^[ \t]*\[desktop\][ \t]*(?:\r?\n|$)/m);
  if (!header || header.index === undefined) return undefined;
  const headerEnd = header.index + header[0].length;
  const rest = source.slice(headerEnd);
  const nextSection = rest.search(/^[ \t]*\[[^\]]+\][ \t]*(?:\r?\n|$)/m);
  const sectionEnd = nextSection === -1 ? source.length : headerEnd + nextSection;
  return { headerEnd, sectionEnd, body: source.slice(headerEnd, sectionEnd) };
}

export function readDesktopAppearanceTheme(source: string): CodexDesktopTheme | undefined {
  const section = desktopSectionBounds(source);
  const match = section?.body.match(/^[ \t]*appearanceTheme[ \t]*=[ \t]*["'](dark|light)["'][ \t]*(?:\r?\n|$)/m);
  return match?.[1] === "dark" || match?.[1] === "light" ? match[1] : undefined;
}

export function preserveDesktopAppearanceTheme(next: string, previous: string): string {
  const theme = readDesktopAppearanceTheme(previous);
  if (!theme) return next;

  const value = `appearanceTheme = ${JSON.stringify(theme)}`;
  const section = desktopSectionBounds(next);
  if (!section) return `${next.replace(/\s*$/, "\n\n")}[desktop]\n${value}\n`;

  const before = next.slice(0, section.headerEnd);
  const after = next.slice(section.sectionEnd);
  if (/^[ \t]*appearanceTheme[ \t]*=/m.test(section.body)) {
    return before + section.body.replace(/^[ \t]*appearanceTheme[ \t]*=.*$/m, value) + after;
  }

  return before + `${value}\n` + section.body + after;
}
