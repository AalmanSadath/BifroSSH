import { useEffect } from 'react';
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
