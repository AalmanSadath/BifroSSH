/**
 * What the file browser shows, and how each column reads.
 *
 * Pure, and apart from the table that draws it, because the order rows are
 * drawn in is not only a matter of looks: a row index means a position in
 * this list, so anything turning an index back into files has to agree with
 * it. A shift-range once sliced the unsorted entries instead, and selected
 * whichever files happened to sit at those positions in directory order.
 */

import type { FileEntry } from './types';

export const HEADERS = ['Name', 'Date Modified', 'Size', 'Owner', 'Type'] as const;
export type SortCol = typeof HEADERS[number];

export interface ListView {
  sortCol: SortCol;
  sortAsc: boolean;
  /** Directories before files, whatever the column being sorted on. */
  dirsOnTop: boolean;
  showHidden: boolean;
  /** Only rows whose name contains this, case-insensitively. Empty shows all. */
  filter: string;
}

/**
 * The rows in the order they are drawn: `..` first, whatever the sort, then
 * what is left of the entries once hidden files and the filter have had their
 * say.
 */
export function visibleEntries(entries: FileEntry[], view: ListView): FileEntry[] {
  const dotdot = entries.filter((e) => e.name === '..');
  const needle = view.filter.toLowerCase();
  const rest = entries
    .filter((e) => e.name !== '..' && (view.showHidden || !e.hidden))
    .filter((e) => needle === '' || e.name.toLowerCase().includes(needle))
    .sort((a, b) => compareEntries(a, b, view));
  return [...dotdot, ...rest];
}

function compareEntries(a: FileEntry, b: FileEntry, view: ListView): number {
  if (view.dirsOnTop && a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
  let cmp = 0;
  if (view.sortCol === 'Name') cmp = a.name.localeCompare(b.name);
  else if (view.sortCol === 'Date Modified') cmp = (a.modified ?? 0) - (b.modified ?? 0);
  else if (view.sortCol === 'Size') cmp = a.size - b.size;
  else if (view.sortCol === 'Owner') cmp = a.owner.localeCompare(b.owner);
  else if (view.sortCol === 'Type') cmp = a.kind.localeCompare(b.kind);
  return view.sortAsc ? cmp : -cmp;
}

/** A size as the list shows it; a directory has none to show. */
export function formatSize(bytes: number, isDir: boolean): string {
  if (isDir) return '- -';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

/** A modification time in the reader's own locale; null for one nobody knows. */
export function formatDate(ts: number | null): string {
  if (!ts) return '- -';
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: 'numeric', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}
