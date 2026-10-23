import { useEffect, useRef } from 'react';

/** Whether a lock is due on return, given when the app went out of sight. */
export function backgroundDue(hiddenAt: number | null, now: number, minutes: number | null): boolean {
  if (minutes === null || hiddenAt === null) return false;
  return now - hiddenAt >= minutes * 60_000;
}

/**
 * Locks when the app comes back after `minutes` out of sight; 0 locks on
 * every return, null is off.
 *
 * Checked on the way back rather than timed while away: a hidden WebView's
 * timers are paused, so a timer set on the way out would only fire on
 * return anyway, late. The lock lands before the user can do anything.
 */
export function useBackgroundLock(minutes: number | null, lock: () => void): void {
  const lockRef = useRef(lock);
  lockRef.current = lock;

  useEffect(() => {
    if (minutes === null) return;
    let hiddenAt: number | null = document.hidden ? Date.now() : null;
    const onChange = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
      } else {
        if (backgroundDue(hiddenAt, Date.now(), minutes)) lockRef.current();
        hiddenAt = null;
      }
    };
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, [minutes]);
}
