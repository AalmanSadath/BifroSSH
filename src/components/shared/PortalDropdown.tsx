import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useBackClose } from '../../backStack';

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

/** Space left under the menu's top before the bottom of the window. */
const BOTTOM_MARGIN = 12;

/**
 * Whether `el` can be seen inside every scrolling box it sits in. A field
 * scrolled up out of a drawer is still in the window, just hidden by the
 * drawer's own clipping, and its menu should not float on over whatever has
 * taken its place.
 */
function inView(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.bottom < 0 || r.top > window.innerHeight) return false;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if (oy !== 'auto' && oy !== 'scroll' && oy !== 'hidden') continue;
    const c = p.getBoundingClientRect();
    if (r.bottom <= c.top || r.top >= c.bottom) return false;
  }
  return true;
}

/**
 * A menu portalled to `document.body` at a fixed position, hanging below
 * `anchor`.
 *
 * Portalled because these hang out of panels that scroll and clip; fixed
 * because the position is in viewport coordinates.
 *
 * The position is not measured once. It follows the anchor: when the panel
 * behind scrolls (the page can be scrolled with the menu open), when the
 * window is resized or maximised, and when the anchor itself changes size.
 * Room opening up below makes the menu taller, up to `maxHeight` if given and
 * the bottom of the window otherwise. An anchor scrolled out of sight hides
 * the menu until it comes back.
 *
 * Rows keep their height and the list scrolls inside. While more of it lies
 * below what is shown, the last slot is a "⋯" row, which scrolls the list
 * when clicked.
 */
export function PortalMenu({
  anchor,
  maxHeight,
  className = 'picker-menu',
  menuRef,
  children,
}: {
  anchor: Element;
  maxHeight?: number;
  className?: string;
  /** The menu's outer element, for a caller that has to tell clicks inside it from clicks outside. */
  menuRef?: React.Ref<HTMLDivElement>;
  children: ReactNode;
}) {
  const [rect, setRect] = useState<AnchorRect | null>(() => anchorBelow(anchor));
  const [visible, setVisible] = useState(true);
  const [more, setMore] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const checkMore = useCallback(() => {
    const el = scrollRef.current;
    if (el) setMore(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  }, []);

  useEffect(() => {
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setRect(anchorBelow(anchor));
        setVisible(inView(anchor));
        checkMore();
      });
    };
    measure();
    // Capture, so a scroll in any panel is heard, not just the window's own.
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    const observer = new ResizeObserver(measure);
    observer.observe(anchor);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
      observer.disconnect();
    };
  }, [anchor, checkMore]);

  // The list's own contents change too (suggestions narrowing as you type).
  useLayoutEffect(checkMore);

  if (!rect || !visible) return null;
  const available = Math.max(0, window.innerHeight - rect.top - BOTTOM_MARGIN);

  function scrollPage() {
    const el = scrollRef.current;
    if (el) el.scrollBy({ top: Math.max(el.clientHeight - 30, 30), behavior: 'smooth' });
  }

  return createPortal(
    <div
      ref={menuRef}
      className={`${className} picker-menu-portal`}
      style={{
        position: 'fixed',
        top: rect.top,
        left: rect.left,
        width: rect.width,
        maxHeight: maxHeight ? Math.min(maxHeight, available) : available,
        zIndex: 9999,
      }}
    >
      <div ref={scrollRef} className="picker-menu-scroll" onScroll={checkMore}>
        {children}
      </div>
      {more && (
        <button
          type="button"
          className="picker-more"
          aria-label="More"
          tabIndex={-1}
          // mousedown, and not letting it take focus: an input the menu belongs
          // to would blur and close it.
          onMouseDown={(e) => { e.preventDefault(); scrollPage(); }}
          onWheel={(e) => scrollRef.current?.scrollBy({ top: e.deltaY })}
        >
          ⋯
        </button>
      )}
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
 * Nothing covers the page while it is open, so the wheel scrolls whatever the
 * pointer is over: the menu's list over the menu, the panel anywhere else,
 * with the menu following its button. A press anywhere outside the button and
 * the menu closes it, and that press still reaches what it landed on.
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
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useBackClose(open ? close : undefined);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || menuRef.current?.contains(t)) return;
      close();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="picker-btn"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        <span>{label}</span>
        {CHEVRON}
      </button>
      {open && btnRef.current && (
        <PortalMenu anchor={btnRef.current} maxHeight={maxHeight} menuRef={menuRef}>
          {children(close)}
        </PortalMenu>
      )}
    </>
  );
}
