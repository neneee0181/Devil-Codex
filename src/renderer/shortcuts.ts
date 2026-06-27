import type { KeyboardEvent as ReactKeyboardEvent } from "react";

export function isMacPlatform(): boolean {
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
}

export function isPrimaryModifier(event: KeyboardEvent | ReactKeyboardEvent): boolean {
  return isMacPlatform() ? event.metaKey : event.ctrlKey;
}

export function shortcut(mac: string, win?: string): string {
  if (isMacPlatform()) return mac;
  if (win) return win;
  return mac
    .replaceAll("⌥", "Alt+")
    .replaceAll("⌃", "Ctrl+")
    .replaceAll("⇧", "Shift+")
    .replaceAll("⌘", "Ctrl+")
    .replace(/\++/g, "+")
    .replace(/\+([,\]\[])/g, "+$1");
}
