/**
 * What this app puts on a drag, and how to read it back.
 *
 * Everything travels as JSON in `text/plain`: WebKitGTK carries only the
 * standard clipboard types across a drag, so a MIME type of our own arrives
 * empty at the other end. Two kinds share that one channel, and each reader
 * has to be able to say "not mine" about the other's payload, and about
 * whatever an outside application happened to put there.
 */

import type { FileEntry } from './types';

/** Marks a dragged terminal tab, since file drags share the same channel. */
export const TAB_DRAG_KIND = 'bifrossh-tab';

export interface FileDrag {
  fromSide: 'left' | 'right';
  dropped: FileEntry[];
}

/** The payload for a tab being dragged into a split. */
export function tabDragPayload(tabId: string): string {
  return JSON.stringify({ kind: TAB_DRAG_KIND, tab_id: tabId });
}

/** The tab id a drop carries, or null for a drop that is not one of ours. */
export function readTabDrag(raw: string): string | null {
  const parsed = parse<{ kind?: string; tab_id?: string }>(raw);
  if (!parsed) return null;
  return parsed.kind === TAB_DRAG_KIND && parsed.tab_id ? parsed.tab_id : null;
}

/** The payload for files dragged out of one SFTP pane. */
export function fileDragPayload(side: 'left' | 'right', entries: FileEntry[]): string {
  return JSON.stringify({ side, entries });
}

/** The files a drop carries, or null when it carries none of ours. */
export function readDragPayload(raw: string): FileDrag | null {
  const parsed = parse<{ side?: 'left' | 'right'; entries?: FileEntry[] }>(raw);
  if (!parsed || !parsed.side || !Array.isArray(parsed.entries)) return null;
  return parsed.entries.length > 0 ? { fromSide: parsed.side, dropped: parsed.entries } : null;
}

/**
 * A drag from outside the app carries whatever that app put on the clipboard,
 * which is not JSON at all as often as not. Nothing to do and nothing worth
 * saying: the drop simply is not one of ours.
 */
function parse<T>(raw: string): T | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return value !== null && typeof value === 'object' ? (value as T) : null;
  } catch {
    return null;
  }
}
