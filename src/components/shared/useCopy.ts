import { useEffect, useRef, useState } from 'react';

/**
 * Copying to the clipboard, with the "Copied" that follows it.
 *
 * Five buttons did this, with four different answers to what happens when the
 * clipboard refuses, one of which was not to ask at all and leave an
 * unhandled rejection behind. They also each set state on a timer nothing
 * cancelled, so a panel closed within a couple of seconds of a press set
 * state on a component that had gone.
 *
 * `copied` is the key of whatever was last copied, so a list of buttons can
 * mark the one that was pressed; a single button passes no key and reads it
 * as a boolean. `failed` is the clipboard refusing, which a caller may show
 * or ignore. `copy` returns whether it worked, for a caller that would rather
 * raise an error of its own.
 */
export function useCopy(resetMs = 2000) {
  const [copied, setCopied] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  function hold(key: string | null, worked: boolean) {
    if (timer.current) clearTimeout(timer.current);
    setCopied(key);
    setFailed(!worked);
    timer.current = setTimeout(() => { setCopied(null); setFailed(false); }, resetMs);
  }

  /** Clears the mark without waiting for it to time out. */
  function clear() {
    if (timer.current) clearTimeout(timer.current);
    setCopied(null);
    setFailed(false);
  }

  async function copy(text: string, key = 'copied'): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      hold(key, true);
      return true;
    } catch {
      hold(null, false);
      return false;
    }
  }

  return { copied, failed, copy, clear };
}
