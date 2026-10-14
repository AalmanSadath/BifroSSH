import { describe, expect, it } from 'vitest';
import type { FileEntry } from '../../types';
import {
  archiveTarget, batchFor, bookmarkKey, browsing, canMove, emptySummary, nextCursor, rangePaths, transferKind,
  type PaneMode,
} from './panes';

function entry(name: string, over: Partial<FileEntry> = {}): FileEntry {
  return {
    name,
    path: name === '..' ? '/' : `/d/${name}`,
    is_dir: false,
    size: 0,
    modified: 0,
    permissions: '',
    owner: '',
    kind: '',
    hidden: false,
    symlink: false,
    mode: null,
    ...over,
  } as FileEntry;
}

const pane = (mode: PaneMode, serverId: string | null = null) => ({ mode, serverId });

describe('which panes can do what', () => {
  it('browses only when showing files', () => {
    expect(browsing(pane('local'))).toBe(true);
    expect(browsing(pane('connected'))).toBe(true);
    for (const mode of ['idle', 'picking', 'connecting'] as const) expect(browsing(pane(mode))).toBe(false);
  });

  it('copies between any two browsing panes but local to local', () => {
    expect(canMove(pane('local'), pane('connected'))).toBe(true);
    expect(canMove(pane('connected'), pane('local'))).toBe(true);
    expect(canMove(pane('connected'), pane('connected'))).toBe(true);
    expect(canMove(pane('local'), pane('local'))).toBe(false);
    expect(canMove(pane('connected'), pane('picking'))).toBe(false);
  });

  it('keys bookmarks by host, or null for the local disk', () => {
    expect(bookmarkKey(pane('local', 'stale'))).toBeNull();
    expect(bookmarkKey(pane('connected', 'h1'))).toBe('h1');
  });

  it('picks the command from which side is local', () => {
    expect(transferKind(null, 's2')).toBe('upload');
    expect(transferKind('s1', null)).toBe('download');
    expect(transferKind('s1', 's2')).toBe('copy');
  });
});

describe('compressed copy target', () => {
  const free = (taken: string[], name: string) => `${name} (${taken.length})`;

  it('unpacks under its own name when nothing is in the way, whatever the answer', () => {
    expect(archiveTarget(['other'], 'logs', 'skip', free)).toEqual({ skip: false, into: null });
  });

  it('follows the answer when the name is taken', () => {
    const taken = ['logs', 'x'];
    expect(archiveTarget(taken, 'logs', 'skip', free)).toEqual({ skip: true });
    expect(archiveTarget(taken, 'logs', 'overwrite', free)).toEqual({ skip: false, into: null });
    expect(archiveTarget(taken, 'logs', 'keep_both', free)).toEqual({ skip: false, into: 'logs (2)' });
  });

  it('reports a skip as one existing item and nothing else', () => {
    expect(emptySummary({ skipped_existing: 1 })).toMatchObject({ files: 0, skipped_existing: 1, cancelled: false, landed: null });
    expect(emptySummary({ cancelled: true }).cancelled).toBe(true);
  });
});

describe('list selection', () => {
  const rows = [entry('..', { is_dir: true }), entry('a'), entry('b'), entry('c')];

  it('selects a range in either direction, never `..`', () => {
    expect(rangePaths(rows, 0, 2)).toEqual(['/d/a', '/d/b']);
    expect(rangePaths(rows, 3, 1)).toEqual(['/d/a', '/d/b', '/d/c']);
  });

  it('moves the cursor onto real rows only', () => {
    // No cursor yet: onto the first real row, whichever way.
    expect(nextCursor(rows, -1, 1)).toBe(1);
    expect(nextCursor(rows, 1, 1)).toBe(2);
    // Up from the first real row would land on `..`, which is skipped, and
    // there is nothing above it.
    expect(nextCursor(rows, 1, -1)).toBeNull();
    expect(nextCursor(rows, 3, 1)).toBeNull();
    expect(nextCursor([entry('..')], -1, 1)).toBeNull();
  });

  it('acts on the whole selection only when the row is part of it', () => {
    const selected = new Set(['/d/a', '/d/c', '/']);
    expect(batchFor(rows, selected, rows[1]).map((e) => e.name)).toEqual(['a', 'c']);
    expect(batchFor(rows, selected, rows[2]).map((e) => e.name)).toEqual(['b']);
  });
});
