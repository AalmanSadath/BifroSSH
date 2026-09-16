import { useEffect, useRef } from 'react';

/** Whether a lock is due, given when the user last did anything. */
export function idleDue(lastActivity: number, now: number, minutes: number): boolean {
  if (minutes <= 0) return false;
  return now - lastActivity >= minutes * 60_000;
}

/** How often the clock is checked. Coarse on purpose: a minute-scale timeout
 *  does not need to fire to the second. */
const TICK_MS = 15_000;

/**
 * Locks after `minutes` with no input from the user. Zero is off.
 *
 * Input means the user's: pointer, keys, wheel. Output arriving from a
 * server is not activity; a `tail -f` left running is exactly the case a
 * timeout exists for. Listeners are on the window in the capture phase so a
 * handler further down, the terminal's own included, cannot swallow the
 * event before it is counted. Mouse movement is throttled to once a second,
 * since it fires continuously and the clock only needs to know it happened.
 */
export function useIdleLock(minutes: number, lock: () => void): void {
  const lastRef = useRef(Date.now());
  const lockRef = useRef(lock);
  lockRef.current = lock;

  useEffect(() => {
    if (minutes <= 0) return;
    lastRef.current = Date.now();

    let lastMove = 0;
    const touch = () => { lastRef.current = Date.now(); };
    const onMove = () => {
      const now = Date.now();
      if (now - lastMove > 1000) { lastMove = now; lastRef.current = now; }
    };
    window.addEventListener('pointerdown', touch, true);
    window.addEventListener('keydown', touch, true);
    window.addEventListener('wheel', touch, true);
    window.addEventListener('mousemove', onMove, true);

    const timer = setInterval(() => {
      if (idleDue(lastRef.current, Date.now(), minutes)) lockRef.current();
    }, TICK_MS);

    return () => {
      clearInterval(timer);
      window.removeEventListener('pointerdown', touch, true);
      window.removeEventListener('keydown', touch, true);
      window.removeEventListener('wheel', touch, true);
      window.removeEventListener('mousemove', onMove, true);
    };
  }, [minutes]);
}
