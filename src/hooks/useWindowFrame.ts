import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useAppStore } from '../store/appStore';
import { isAndroid } from '../platform';

/**
 * Whether this window draws its own title bar controls.
 *
 * Android has no window frame at all, so there is nothing to draw there.
 */
export function useCustomFrame(): boolean {
  const frame = useAppStore((s) => s.settings.window_frame);
  return !isAndroid && frame === 'custom';
}

/**
 * Keeps the window's system frame in step with the setting, live. Every
 * window runs this, the main one and a tab's own.
 *
 * The main window is configured without a frame. Before the settings load,
 * the setting holds the value cached from the last run, so a user who chose
 * the native frame gets it back as soon as the page starts.
 */
export function useWindowFrame(): void {
  const custom = useCustomFrame();
  useEffect(() => {
    if (isAndroid) return;
    getCurrentWindow().setDecorations(!custom).catch(() => {});
  }, [custom]);
}

/** Whether this window is maximized, followed while `watch` is on. */
export function useMaximized(watch: boolean): boolean {
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
 * How wide, in CSS pixels, the band along the window's edge is where Tauri
 * resizes a frameless window, or 0 when there is none: a framed window, a
 * maximized one, or Android.
 *
 * Tauri takes the pointer there before the page sees it, at 5 pixels times
 * the desktop's whole scale factor. WebKitGTK's overlay scrollbars only
 * answer to the pointer within a few pixels of their own edge, so one along
 * the window's right edge could not be reached at all; the page keeps its
 * scroll areas this far in.
 */
export function useResizeBand(): number {
  const custom = useCustomFrame();
  const maximized = useMaximized(custom);
  if (!custom || maximized) return 0;
  return 5 * Math.max(1, Math.floor(window.devicePixelRatio));
}
