import type { Conflict, FileEntry, TransferKind, TransferSummary } from '../../types';

/** What a pane is showing. Both panes use all five. */
export type PaneMode = 'local' | 'idle' | 'picking' | 'connecting' | 'connected';

/**
 * A message over the list. An error is painted so it looks like one; a
 * report of something that went fine, a transfer summary or an upload
 * behind an opened file, is painted so it does not.
 */
export interface Notice {
  text: string;
  kind: 'error' | 'info';
}

/** One directory, as shown. The four move together, so they are stored together. */
export interface Listing {
  path: string;
  entries: FileEntry[];
  loading: boolean;
  error: string;
  /** The home directory, once fetched, so a typed `~` has somewhere to go. */
  home: string | null;
}

export const emptyListing = (loading: boolean): Listing => ({ path: '', entries: [], loading, error: '', home: null });

/** The part of a pane the rules below look at. */
interface PaneState {
  mode: PaneMode;
  serverId: string | null;
}

/** Whether a pane is showing files rather than picking a host or connecting. */
export function browsing(p: Pick<PaneState, 'mode'>): boolean {
  return p.mode === 'local' || p.mode === 'connected';
}

/** Whether dragging from `src` onto `dst` is a transfer this app can make. */
export function canMove(src: Pick<PaneState, 'mode'>, dst: Pick<PaneState, 'mode'>): boolean {
  // Local to local is the one pairing with no command behind it.
  return browsing(src) && browsing(dst) && !(src.mode === 'local' && dst.mode === 'local');
}

/** Which list a pane's bookmarks come from: its host, or the local disk. */
export function bookmarkKey(pane: PaneState): string | null {
  return pane.mode === 'local' ? null : pane.serverId;
}

/**
 * Which of the three commands a copy between two panes runs, from their
 * sessions: null is the local disk. Local to remote uploads, remote to local
 * downloads, remote to remote copies.
 */
export function transferKind(srcSid: string | null, dstSid: string | null): TransferKind {
  return srcSid === null ? 'upload' : dstSid === null ? 'download' : 'copy';
}

/** A transfer that moved nothing, with whatever it did do said in `over`. */
export function emptySummary(over: Partial<TransferSummary> = {}): TransferSummary {
  return {
    files: 0, directories: 0, skipped_symlinks: 0, skipped_names: 0, skipped_existing: 0, renamed: 0,
    cancelled: false, resumed: 0, mismatched: [], resumable: 0, landed: null, verified: 0, failed: null,
    ...over,
  };
}

/**
 * Where a compressed copy unpacks, given the conflict answer: `skip` when it
 * should not run at all, otherwise the name to unpack under, null being the
 * directory's own.
 *
 * Only the top-level name is checked, against the listing already on screen:
 * listing the whole tree to compare it file by file is the round trip a
 * compressed copy exists to avoid, and tar unpacking over a directory merges
 * into it either way.
 */
export function archiveTarget(
  taken: string[],
  name: string,
  conflict: Conflict,
  freeName: (taken: string[], name: string) => string,
): { skip: true } | { skip: false; into: string | null } {
  if (!taken.includes(name)) return { skip: false, into: null };
  if (conflict === 'skip') return { skip: true };
  return { skip: false, into: conflict === 'keep_both' ? freeName(taken, name) : null };
}

/** The paths of the rows from `a` to `b`, both included, in either order, leaving out `..`. */
export function rangePaths(rows: FileEntry[], a: number, b: number): string[] {
  return rows.slice(Math.min(a, b), Math.max(a, b) + 1).filter((en) => en.name !== '..').map((en) => en.path);
}

/**
 * The row an arrow key moves the cursor onto, or null when there is none to
 * move to. From the cursor if there is one, else onto the first real row;
 * `..` is not a row the cursor stops on.
 */
export function nextCursor(rows: FileEntry[], cursor: number, step: 1 | -1): number | null {
  let next = cursor >= 0 ? cursor + step : rows.findIndex((en) => en.name !== '..');
  if (next >= 0 && next < rows.length && rows[next].name === '..') next += step;
  return next >= 0 && next < rows.length && rows[next].name !== '..' ? next : null;
}

/**
 * The entries an action on `entry` applies to: the whole selection when the
 * entry is part of it, otherwise that entry alone. Dragging one row of a
 * highlighted set used to carry only that row, so a multi-select copied one
 * file and quietly dropped the rest.
 */
export function batchFor(rows: FileEntry[], selected: Set<string>, entry: FileEntry): FileEntry[] {
  if (!selected.has(entry.path)) return [entry];
  return rows.filter((en) => en.name !== '..' && selected.has(en.path));
}
