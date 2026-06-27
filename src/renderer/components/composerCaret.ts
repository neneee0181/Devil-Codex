export type CaretPosition = { left: number; top: number };

const mirroredProperties = [
  "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight",
  "textTransform", "wordSpacing", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
] as const;

export function getTextareaCaretPosition(textarea: HTMLTextAreaElement, caret: number): CaretPosition {
  const style = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");
  mirror.style.position = "fixed";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.style.width = `${textarea.offsetWidth}px`;
  for (const property of mirroredProperties) mirror.style[property] = style[property];

  mirror.textContent = textarea.value.slice(0, caret);
  const marker = document.createElement("span");
  marker.textContent = textarea.value.slice(caret) || ".";
  mirror.append(marker);
  document.body.append(mirror);
  const lineHeight = Number.parseFloat(style.lineHeight) || 21;
  const position = {
    left: textarea.offsetLeft + marker.offsetLeft - textarea.scrollLeft,
    top: textarea.offsetTop + marker.offsetTop - textarea.scrollTop + lineHeight + 5,
  };
  mirror.remove();
  return position;
}
