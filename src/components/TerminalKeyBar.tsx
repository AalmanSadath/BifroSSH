import { useSyncExternalStore } from 'react';
import { getLatch, subscribeLatch, toggleLatch } from '../keyLatch';

/** What a key on the bar asks the focused terminal for. */
export type KeyBarKey =
  | 'esc' | 'tab' | 'up' | 'down' | 'left' | 'right'
  | 'home' | 'end' | 'pgup' | 'pgdn' | 'paste'
  | { text: string }
  /** Text from elsewhere (an Android share), pasted as the clipboard is. */
  | { paste: string };

export const KEYBAR_EVENT = 'bifrossh-keybar';

const KEYS: { label: string; key: KeyBarKey; wide?: boolean }[] = [
  { label: 'Esc', key: 'esc' },
  { label: 'Tab', key: 'tab' },
  { label: '←', key: 'left' },
  { label: '↓', key: 'down' },
  { label: '↑', key: 'up' },
  { label: '→', key: 'right' },
  { label: 'Home', key: 'home' },
  { label: 'End', key: 'end' },
  { label: 'PgUp', key: 'pgup' },
  { label: 'PgDn', key: 'pgdn' },
  { label: '|', key: { text: '|' } },
  { label: '/', key: { text: '/' } },
  { label: '~', key: { text: '~' } },
  { label: '-', key: { text: '-' } },
  { label: 'Paste', key: 'paste', wide: true },
];

/**
 * The keys a touch keyboard does not have, in a row above it.
 *
 * Pointerdown is cancelled, so a press does not take focus from the
 * terminal and fold the keyboard away under the finger. The key itself acts
 * on click, which a sideways scroll of the bar does not produce. The keys go
 * to the focused terminal as an event, which turns them into what its modes
 * call for.
 */
export default function TerminalKeyBar() {
  const latch = useSyncExternalStore(subscribeLatch, getLatch);

  const press = (key: KeyBarKey) => () => {
    window.dispatchEvent(new CustomEvent<KeyBarKey>(KEYBAR_EVENT, { detail: key }));
  };
  const keepFocus = (e: React.PointerEvent) => e.preventDefault();

  return (
    <div className="keybar" onContextMenu={(e) => e.preventDefault()}>
      <button className={`keybar-key${latch.ctrl ? ' keybar-latched' : ''}`} onPointerDown={keepFocus} onClick={() => toggleLatch('ctrl')}>Ctrl</button>
      <button className={`keybar-key${latch.alt ? ' keybar-latched' : ''}`} onPointerDown={keepFocus} onClick={() => toggleLatch('alt')}>Alt</button>
      {KEYS.map(({ label, key, wide }) => (
        <button key={label} className={`keybar-key${wide ? ' keybar-wide' : ''}`} onPointerDown={keepFocus} onClick={press(key)}>
          {label}
        </button>
      ))}
    </div>
  );
}
