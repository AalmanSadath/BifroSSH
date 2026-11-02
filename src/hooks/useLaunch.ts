import { useEffect, useRef } from 'react';
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import * as ipc from '../ipc';
import { isAndroid } from '../platform';
import type { Launch } from '../types';

declare global {
  interface Window {
    /** A launch arrived while the app was running (MainActivity.handleLaunch). */
    __bifrosshLaunch?: () => void;
  }
}

/**
 * Acts on what the app was opened for: a launcher shortcut or jump list
 * host, an ssh:// link, or text shared on Android.
 *
 * Asked for only once `ready`, meaning unlocked and loaded, since every one
 * of them needs the saved hosts. One that arrives while locked waits in the
 * backend (MainActivity on Android) until then; one that arrives while ready
 * is taken at once. Android says so through `window.__bifrosshLaunch`, the
 * desktop with a `launch` event from a second launch.
 */
export function useLaunch(ready: boolean, handle: (launch: Launch) => void): void {
  const handleRef = useRef(handle);
  handleRef.current = handle;

  useEffect(() => {
    if (!ready) return;
    const take = () => {
      ipc.takeLaunch()
        .then((launch) => { if (launch) handleRef.current(launch); })
        .catch(() => {});
    };
    take();
    if (isAndroid) {
      window.__bifrosshLaunch = take;
      return () => { delete window.__bifrosshLaunch; };
    }
    // This window's own events only: the backend sends launches to the
    // main window, and a detached tab's window must not take them too.
    const unlisten = getCurrentWebviewWindow().listen('launch', take);
    return () => { void unlisten.then((f) => f()); };
  }, [ready]);
}
