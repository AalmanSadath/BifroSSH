import { useEffect, useRef } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';

type Side = 'left' | 'right';

/**
 * Drops from outside the app. The webview reports these itself, with real
 * filesystem paths, which an HTML5 drop event never carries. The event is
 * window-wide, so the pane under the cursor is found from the position.
 *
 * Linux only, by configuration rather than by code: tauri.linux.conf.json
 * enables the webview's drag and drop, and tauri.conf.json leaves it off
 * because on Windows enabling it disables HTML5 drag and drop, which is
 * what moves files between the two panes. On Windows this listener is
 * registered and never fires.
 */
export function useExternalDrop(setDropTarget: (side: Side | null) => void, onDrop: (target: Side, paths: string[]) => void) {
  // The drag-drop event fires from a listener registered once, so it reads
  // the handler through a ref rather than closing over the first render's
  // panes, which would upload into whatever directory was open at startup.
  const onDropRef = useRef(onDrop);
  onDropRef.current = onDrop;

  useEffect(() => {
    // The type says physical; the number is not. On WebKitGTK the position
    // comes from GTK's drag_motion, which reports logical widget coordinates,
    // and wry 0.55 passes them through unscaled (webkitgtk/drag_drop.rs:96).
    // Dividing by devicePixelRatio, as the type invites, halved x on a HiDPI
    // display and put every drop on the left pane. This listener only ever
    // fires on Linux, so the GTK behaviour is the only one that matters.
    const paneAt = (position: { x: number; y: number }): Side | null => {
      const el = document.elementFromPoint(position.x, position.y);
      const side = el?.closest<HTMLElement>('[data-side]')?.dataset.side;
      return side === 'left' || side === 'right' ? side : null;
    };
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === 'enter' || p.type === 'over') {
        setDropTarget(paneAt(p.position));
      } else if (p.type === 'leave') {
        setDropTarget(null);
      } else if (p.type === 'drop') {
        const target = paneAt(p.position);
        setDropTarget(null);
        if (target && p.paths.length > 0) void onDropRef.current(target, p.paths);
      }
    });
    return () => { unlisten.then((f) => f()); };
  // `setDropTarget` is a state setter, the same function on every render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
