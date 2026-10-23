import { useEffect, useRef } from 'react';
import * as ipc from '../ipc';
import { isAndroid } from '../platform';
import type { AndroidLaunch } from '../types';

declare global {
  interface Window {
    /** A launch arrived while the app was running (MainActivity.handleLaunch). */
    __bifrosshLaunch?: () => void;
  }
}

/**
 * Acts on what the Android app was opened for: a launcher shortcut, an
 * ssh:// link or shared text.
 *
 * Asked for only once `ready`, meaning unlocked and loaded, since every one
 * of them needs the saved hosts. One that arrives while locked waits in
 * MainActivity until then; one that arrives while ready is taken at once.
 */
export function useAndroidLaunch(ready: boolean, handle: (launch: AndroidLaunch) => void): void {
  const handleRef = useRef(handle);
  handleRef.current = handle;

  useEffect(() => {
    if (!isAndroid || !ready) return;
    const take = () => {
      ipc.androidTakeLaunch()
        .then((launch) => { if (launch) handleRef.current(launch); })
        .catch(() => {});
    };
    take();
    window.__bifrosshLaunch = take;
    return () => { delete window.__bifrosshLaunch; };
  }, [ready]);
}
