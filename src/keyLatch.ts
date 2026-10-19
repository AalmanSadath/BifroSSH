/**
 * Ctrl and Alt from the extra-key bar, held for the next key.
 *
 * A touch keyboard has neither, so the bar's Ctrl and Alt latch: tapped,
 * they wait for the next key typed anywhere, on the bar or the keyboard,
 * and apply to it once. TerminalView runs everything typed through
 * `applyLatch` on its way to the session.
 */

export interface Latch {
  ctrl: boolean;
  alt: boolean;
}

let latch: Latch = { ctrl: false, alt: false };
const listeners = new Set<() => void>();

function set(next: Latch): void {
  latch = next;
  listeners.forEach((l) => l());
}

export function getLatch(): Latch {
  return latch;
}

export function subscribeLatch(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function toggleLatch(key: keyof Latch): void {
  set({ ...latch, [key]: !latch[key] });
}

/** The control character Ctrl makes of `ch`, or null when it makes none. */
export function ctrlOf(ch: string): string | null {
  if (/^[a-zA-Z]$/.test(ch)) return String.fromCharCode(ch.toUpperCase().charCodeAt(0) & 0x1f);
  const special: Record<string, number> = {
    '@': 0x00, ' ': 0x00, '[': 0x1b, '\\': 0x1c, ']': 0x1d, '^': 0x1e, '_': 0x1f, '?': 0x7f,
  };
  return ch in special ? String.fromCharCode(special[ch]) : null;
}

/**
 * `data` as the latched modifiers make it, releasing them. Ctrl applies to a
 * single character; Alt puts Escape in front of whatever was typed, as a
 * terminal's Meta does.
 */
export function applyLatch(data: string): string {
  if (!latch.ctrl && !latch.alt) return data;
  let out = data;
  if (latch.ctrl && [...data].length === 1) out = ctrlOf(data) ?? data;
  if (latch.alt) out = '\x1b' + out;
  set({ ctrl: false, alt: false });
  return out;
}
