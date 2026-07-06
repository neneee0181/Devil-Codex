import { useCallback, useEffect, useRef } from "react";
import { animate } from "motion/react";

/**
 * Pointer-tracked accent ring, adapted from the "glowing-effect" spotlight
 * card pattern to this project's plain CSS (no Tailwind/shadcn/`cn` helper
 * here) - a conic-gradient border masked to a wedge that follows the
 * pointer angle around the host element. Render it as the last child of a
 * `position: relative` container with the `glow-host` class; it renders an
 * absolutely-positioned `<div className="glow-ring">` sized to match.
 *
 * Touch screens never fire `pointermove` continuously, so this simply stays
 * at rest (opacity 0) there - no error, no wasted work, the card just reads
 * as a normal static card.
 */
export function GlowRing({ spread = 55, borderWidth = 1.5, proximity = 40, inactiveZone = 0.03 }: {
  spread?: number;
  borderWidth?: number;
  proximity?: number;
  inactiveZone?: number;
}): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const last = useRef({ x: 0, y: 0 });
  const raf = useRef(0);

  const handleMove = useCallback((point?: { x: number; y: number }) => {
    const element = ref.current;
    if (!element) return;
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const { left, top, width, height } = element.getBoundingClientRect();
      const x = point?.x ?? last.current.x;
      const y = point?.y ?? last.current.y;
      if (point) last.current = { x, y };

      const centerX = left + width / 2;
      const centerY = top + height / 2;
      const distance = Math.hypot(x - centerX, y - centerY);
      const inactiveRadius = 0.5 * Math.min(width, height) * inactiveZone;
      if (distance < inactiveRadius) {
        element.style.setProperty("--active", "0");
        return;
      }

      const isActive = x > left - proximity && x < left + width + proximity && y > top - proximity && y < top + height + proximity;
      element.style.setProperty("--active", isActive ? "1" : "0");
      if (!isActive) return;

      const current = parseFloat(element.style.getPropertyValue("--start")) || 0;
      const target = (180 * Math.atan2(y - centerY, x - centerX)) / Math.PI + 90;
      const diff = ((target - current + 180) % 360) - 180;
      void animate(current, current + diff, {
        duration: 0.45,
        ease: [0.16, 1, 0.3, 1],
        onUpdate: (value) => element.style.setProperty("--start", String(value)),
      });
    });
  }, [inactiveZone, proximity]);

  useEffect(() => {
    const onPointerMove = (event: PointerEvent): void => handleMove(event);
    document.body.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      document.body.removeEventListener("pointermove", onPointerMove);
    };
  }, [handleMove]);

  return (
    <div
      ref={ref}
      className="glow-ring"
      style={{ "--glow-spread": spread, "--glow-width": `${borderWidth}px` } as React.CSSProperties}
    />
  );
}
