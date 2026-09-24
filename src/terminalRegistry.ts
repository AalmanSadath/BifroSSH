/**
 * The live terminal behind each tab, by tab id.
 *
 * A terminal is built inside `TerminalView`'s once-per-tab effect and kept in
 * a ref there, so nothing above it can reach the buffer. The tab's own menu
 * lives in `App`, which is above it. This is the one line between the two: a
 * map filled on mount and emptied on unmount, holding no React state, since
 * what it points at is not state either.
 */

import type { Terminal } from '@xterm/xterm';

const terminals = new Map<string, Terminal>();

export function registerTerminal(tabId: string, term: Terminal): void {
  terminals.set(tabId, term);
}

export function unregisterTerminal(tabId: string): void {
  terminals.delete(tabId);
}

/** The terminal for a tab, or undefined once the tab has gone. */
export function terminalFor(tabId: string): Terminal | undefined {
  return terminals.get(tabId);
}
