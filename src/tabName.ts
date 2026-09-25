/**
 * What a tab is called.
 *
 * `server_name` is the host's name plus a counter when the same host has more
 * than one tab, and it is what names a log file and a saved transcript. A
 * title is the name the user gave this one tab, which is a different thing:
 * two tabs on the same host are told apart by what they are for, not by "(1)".
 */

import type { SessionTab } from './types';

/** The name to show for a tab. */
export function tabLabel(tab: Pick<SessionTab, 'server_name' | 'title'>): string {
  return tab.title ?? tab.server_name;
}

/**
 * A typed name, or undefined for "no name of its own".
 *
 * Blank clears it, and so does typing the host's name back: the user meant to
 * undo the rename, and a title that matches would otherwise stop the counter
 * ever showing again on a second tab.
 */
export function cleanTitle(raw: string, serverName: string): string | undefined {
  const name = raw.trim();
  return name === '' || name === serverName ? undefined : name;
}
