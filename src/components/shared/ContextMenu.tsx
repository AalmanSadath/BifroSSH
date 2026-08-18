import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/**
 * A menu placed at a point, dismissed by any mousedown outside it.
 *
 * Six of these were hand-rolled, and each kept itself on screen with its own
 * guess at its own height: `innerHeight - 60`, `- 80`, `- 100`, `- 120`,
 * `- 130`, `- 200`. Every one of those was wrong as soon as the menu's
 * contents changed, which for most of them depends on how many sessions or
 * rules happen to be open.
 *
 * This measures the menu instead. The measurement runs in a layout effect, so
 * the corrected position is in place before the browser paints and there is no
 * visible jump.
 */
export default function ContextMenu({
  x,
  y,
  className = 'host-context-menu',
  onClose,
  children,
}: {
  x: number;
  y: number;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: y, left: x });

  // No dependency list: the menu's size changes with its contents, and several
  // callers swap those out in place (a rename field replacing the item list).
  // Bailing out when the position is unchanged is what stops this looping.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const top = Math.max(4, Math.min(y, window.innerHeight - height - 4));
    const left = Math.max(4, Math.min(x, window.innerWidth - width - 4));
    setPos((p) => (p.top === top && p.left === left ? p : { top, left }));
  });

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [onClose]);

  return (
    <div ref={ref} className={className} style={{ top: pos.top, left: pos.left }}>
      {children}
    </div>
  );
}
