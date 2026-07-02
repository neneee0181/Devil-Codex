import type { ClipboardEvent } from "react";
import type { CaretPosition } from "./composerCaret";

function clipboardHtmlToText(html: string): string {
  const container = document.createElement("div");
  container.innerHTML = html;
  return container.innerText || container.textContent || "";
}

function normalizePastedText(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/\u00a0/g, " ");
}

export function insertPlainTextAtSelection(editor: HTMLDivElement, text: string): boolean {
  const value = normalizePastedText(text);
  if (!value) return false;

  const selection = window.getSelection();
  if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) {
    editor.append(document.createTextNode(value));
    return true;
  }

  const range = selection.getRangeAt(0);
  if (!editor.contains(range.commonAncestorContainer)) return false;

  range.deleteContents();
  const node = document.createTextNode(value);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  return true;
}

export function plainTextFromClipboard(event: ClipboardEvent): string {
  const clipboard = event.clipboardData;
  const plain = clipboard.getData("text/plain");
  if (plain) return normalizePastedText(plain);
  const html = clipboard.getData("text/html");
  return html ? normalizePastedText(clipboardHtmlToText(html)) : "";
}

export function getEditorTextBeforeCaret(editor: HTMLDivElement): string | null {
  const selection = window.getSelection();
  const anchorNode = selection?.anchorNode;
  if (!selection?.rangeCount || !anchorNode || !editor.contains(anchorNode)) return null;
  const range = selection.getRangeAt(0).cloneRange();
  range.selectNodeContents(editor);
  range.setEnd(anchorNode, selection.anchorOffset);
  return range.toString();
}

export function getEditorCaretPosition(editor: HTMLDivElement): CaretPosition | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !editor.contains(selection.anchorNode)) return null;
  const range = selection.getRangeAt(0).cloneRange();
  range.collapse(true);
  const rect = range.getBoundingClientRect();
  return {
    left: Math.max(8, rect.left),
    top: Math.max(0, rect.bottom + 5),
  };
}

export function insertInlineSkill(editor: HTMLDivElement, skill: string, triggerLength: number, label?: string): boolean {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return false;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.startContainer) || range.startContainer.nodeType !== Node.TEXT_NODE || range.startOffset < triggerLength) return false;
  const start = range.cloneRange();
  start.setStart(range.startContainer, range.startOffset - triggerLength);
  start.deleteContents();

  const token = document.createElement("span");
  token.className = "composer-inline-skill";
  token.contentEditable = "false";
  token.dataset.skill = skill;
  const icon = document.createElement("span");
  icon.className = "composer-inline-skill-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "◇";
  const text = document.createElement("span");
  text.textContent = label ?? skill.split(/[-_]/).map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : "").join(" ");
  token.append(icon, text);
  start.insertNode(token);
  const spacer = document.createTextNode(" ");
  token.after(spacer);
  start.setStartAfter(spacer);
  start.collapse(true);
  selection.removeAllRanges();
  selection.addRange(start);
  return true;
}

export function removeEditorTrigger(editor: HTMLDivElement, triggerLength: number): boolean {
  const selection = window.getSelection();
  if (!selection?.rangeCount) return false;
  const range = selection.getRangeAt(0);
  if (!editor.contains(range.startContainer) || range.startContainer.nodeType !== Node.TEXT_NODE || range.startOffset < triggerLength) return false;
  const start = range.cloneRange();
  start.setStart(range.startContainer, range.startOffset - triggerLength);
  start.deleteContents();
  selection.removeAllRanges();
  selection.addRange(start);
  return true;
}

export function editorText(editor: HTMLDivElement): string {
  const copy = editor.cloneNode(true) as HTMLDivElement;
  copy.querySelectorAll(".composer-inline-skill").forEach((node) => node.remove());
  return copy.innerText.replace(/\u00a0/g, " ").trim();
}

export function editorSkills(editor: HTMLDivElement): string[] {
  return [...editor.querySelectorAll<HTMLElement>(".composer-inline-skill[data-skill]")].map((node) => node.dataset.skill ?? "").filter(Boolean);
}
