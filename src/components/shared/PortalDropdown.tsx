import { useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface AnchorRect {
  top: number;
  left: number;
  width: number;
}

/** The rect a menu should occupy if it hangs below `el`. */
export function anchorBelow(el: Element | null | undefined): AnchorRect | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.bottom + 2, left: r.left, width: r.width };
}

/**
 * A menu portalled to `document.body` at a fixed position.
 *
 * Portalled because these hang out of panels that scroll and clip; fixed
 * because the anchor rect is measured in viewport coordinates.
 *
 * `maxHeight` caps the menu; without one it simply stops short of the bottom of
 * the window. Either way it scrolls rather than running off the screen.
 */
export function PortalMenu({
  rect,
  maxHeight,
  className = 'picker-menu',
  children,
}: {
  rect: AnchorRect;
  maxHeight?: number;
  className?: string;
  children: ReactNode;
}) {
  const available = window.innerHeight - rect.top - 12;
  return createPortal(
    <div
      className={className}
      style={{
        position: 'fixed',
        top: rect.top,
        left: rect.left,
        width: rect.width,
        maxHeight: maxHeight ? Math.min(maxHeight, available) : available,
        overflowY: 'auto',
        zIndex: 9999,
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

export const CHEVRON = (
  <svg width="10" height="6" viewBox="0 0 10 6" fill="currentColor"><path d="M0 0l5 6 5-6z" /></svg>
);

/**
 * A `<select>`-shaped button whose menu is portalled out of the layout.
 *
 * The scrim under the menu is what closes it. It has to be a real element
 * rather than a document listener because the menu itself lives outside the
 * button's subtree, so "clicked outside" is not a containment test any more.
 *
 * Items go through `children` as a function of `close` so that a caller can
 * render whatever it likes in the menu (groups, dividers, an "add" row) and
 * still dismiss it.
 */
export default function PortalDropdown({
  label,
  maxHeight,
  disabled,
  children,
}: {
  label: ReactNode;
  maxHeight?: number;
  disabled?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const [rect, setRect] = useState<AnchorRect | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const close = () => setRect(null);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="picker-btn"
        disabled={disabled}
        onClick={() => setRect(anchorBelow(btnRef.current))}
      >
        <span>{label}</span>
        {CHEVRON}
      </button>
      {rect && (
        <>
          {createPortal(
            <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onMouseDown={close} />,
            document.body,
          )}
          <PortalMenu rect={rect} maxHeight={maxHeight}>
            {children(close)}
          </PortalMenu>
        </>
      )}
    </>
  );
}
