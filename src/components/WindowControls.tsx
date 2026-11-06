import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useCustomFrame } from '../hooks/useWindowFrame';

/** Whether this window is maximized, followed while `watch` is on. */
function useMaximized(watch: boolean): boolean {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!watch) return;
    const win = getCurrentWindow();
    const check = () => { win.isMaximized().then(setMaximized).catch(() => {}); };
    check();
    const unlisten = win.onResized(check);
    return () => { void unlisten.then((fn) => fn()); };
  }, [watch]);
  return maximized;
}

/**
 * Minimize, maximize and close, drawn by the app when the window has no
 * system frame. Renders nothing when it has one, and on Android.
 *
 * Close goes through the window's close request, as the system button would,
 * so whatever a window does on closing still runs.
 */
export default function WindowControls() {
  const custom = useCustomFrame();
  const maximized = useMaximized(custom);

  if (!custom) return null;
  const win = getCurrentWindow();

  return (
    <div className="window-controls">
      <button className="window-control" aria-label="Minimize" onClick={() => void win.minimize()}>
        <svg width="10" height="10" viewBox="0 0 10 10"><line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" strokeWidth="1.2" /></svg>
      </button>
      <button
        className="window-control"
        aria-label={maximized ? 'Restore' : 'Maximize'}
        onClick={() => void win.toggleMaximize()}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
            <rect x="0.6" y="2.6" width="6.8" height="6.8" />
            <path d="M2.6 2.6V0.6h6.8v6.8H7.4" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.2">
            <rect x="0.6" y="0.6" width="8.8" height="8.8" />
          </svg>
        )}
      </button>
      <button className="window-control window-control-close" aria-label="Close" onClick={() => void win.close()}>
        <svg width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" strokeWidth="1.2">
          <line x1="0" y1="0" x2="10" y2="10" />
          <line x1="10" y1="0" x2="0" y2="10" />
        </svg>
      </button>
    </div>
  );
}

/**
 * A strip across the top of a screen that has no bar of its own, such as the
 * unlock screen: something to drag the window by, and its buttons.
 */
export function WindowDragStrip() {
  const custom = useCustomFrame();
  if (!custom) return null;
  return (
    <div className="window-drag-strip" data-tauri-drag-region>
      <WindowControls />
    </div>
  );
}
