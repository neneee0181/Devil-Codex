import { useEffect, useRef, type RefObject } from "react";

export function useOutsideDismiss<T extends HTMLElement>(ref: RefObject<T | null>, onDismiss: () => void, enabled: boolean, ignoreRef?: RefObject<HTMLElement | null>): void {
  const callback = useRef(onDismiss);
  callback.current = onDismiss;
  useEffect(() => {
    if (!enabled) return;
    const pointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target)) return;
      if (ignoreRef?.current?.contains(target)) return;
      callback.current();
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") callback.current(); };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", pointer, true); document.removeEventListener("keydown", key); };
  }, [enabled, ref, ignoreRef]);
}

export function useDismissShellPopovers(onDismiss: () => void): void {
  const callback = useRef(onDismiss);
  callback.current = onDismiss;
  useEffect(() => {
    const pointer = (event: PointerEvent) => {
      const inside = (event.target as Element).closest("[data-shell-popover-root], .project-menu, .thread-menu, [aria-label='프로젝트 메뉴'], [aria-label='스레드 메뉴']");
      if (!inside) callback.current();
    };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") callback.current(); };
    document.addEventListener("pointerdown", pointer, true);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", pointer, true); document.removeEventListener("keydown", key); };
  }, []);
}
