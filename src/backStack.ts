import { useEffect, useRef } from 'react';
import { isAndroid } from './platform';

/**
 * Android's Back gesture, which closes whatever was opened last.
 *
 * Anything that can be dismissed registers its close while it is open, and
 * Back calls the newest. With nothing open, Back takes the fallback App sets,
 * which steps back to the Hosts page; from there it leaves the app.
 *
 * MainActivity asks `window.__bifrosshBack` on every Back and leaves the app
 * when it answers false. Page history would be the web way, but the WebView
 * skips history entries a page pushes without a tap, which is every entry
 * pushed again after a Back, so the second Back left the app.
 */
const stack: Array<{ close: () => void }> = [];

interface Fallback {
  /** Whether there is somewhere to step back to. */
  can: () => boolean;
  step: () => void;
}

let fallback: Fallback = { can: () => false, step: () => {} };

export function setBackFallback(next: Fallback): void {
  fallback = next;
}

/** One Back. True when it was spent here, false to leave the app. */
function back(): boolean {
  const top = stack[stack.length - 1];
  if (top) {
    top.close();
    return true;
  }
  if (fallback.can()) {
    fallback.step();
    return true;
  }
  return false;
}

if (isAndroid) {
  (window as unknown as { __bifrosshBack: () => boolean }).__bifrosshBack = back;
}

/**
 * Registers `onClose` for Back while it is given. Pass undefined while the
 * thing is shut, for a component that stays mounted either way.
 */
export function useBackClose(onClose: (() => void) | undefined): void {
  const ref = useRef(onClose);
  ref.current = onClose;
  const open = onClose !== undefined;
  useEffect(() => {
    if (!isAndroid || !open) return;
    const entry = { close: () => ref.current?.() };
    stack.push(entry);
    return () => {
      const i = stack.lastIndexOf(entry);
      if (i >= 0) stack.splice(i, 1);
    };
  }, [open]);
}
