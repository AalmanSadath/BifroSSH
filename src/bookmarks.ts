/**
 * Saved directories for the SFTP panel. Pure helpers, tested; the panel
 * owns the list and the store persists it.
 */

import type { PathStyle } from './paths';
import type { SftpBookmark } from './types';

/**
 * A pane's own bookmarks, in label order. `serverId` is null for the local
 * pane, whose paths mean nothing on a server and the other way round.
 */
export function bookmarksFor(list: SftpBookmark[], serverId: string | null): SftpBookmark[] {
  return list
    .filter((b) => (b.server_id ?? null) === serverId)
    .sort((a, b) => a.label.localeCompare(b.label) || a.path.localeCompare(b.path));
}

/** Whether this exact directory is already saved for this pane. */
export function isBookmarked(list: SftpBookmark[], serverId: string | null, path: string): boolean {
  return bookmarksFor(list, serverId).some((b) => b.path === path);
}

/**
 * What to call a bookmark for `path`: its last segment, or the path itself
 * at a root, where there is no segment to take.
 */
export function labelFor(path: string, style: PathStyle): string {
  const name = style.basename(path);
  return name === '' ? path : name;
}
