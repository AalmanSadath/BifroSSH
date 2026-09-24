import { describe, expect, it } from 'vitest';
import { formatDate, formatSize, visibleEntries, type ListView } from './fileList';
import type { FileEntry } from './types';

function entry(over: Partial<FileEntry> & { name: string }): FileEntry {
  return {
    path: `/x/${over.name}`,
    is_dir: false,
    size: 0,
    modified: 0,
    permissions: '-rw-r--r--',
    mode: 0o644,
    uid: 0,
    gid: 0,
    owner: 'root',
    kind: 'file',
    hidden: over.name.startsWith('.'),
    symlink: false,
    ...over,
  };
}

const view = (over: Partial<ListView> = {}): ListView =>
  ({ sortCol: 'Name', sortAsc: true, dirsOnTop: true, showHidden: false, filter: '', ...over });

const names = (entries: FileEntry[]) => entries.map((e) => e.name);

describe('visibleEntries', () => {
  const rows = [
    entry({ name: 'b.txt', size: 300, modified: 30 }),
    entry({ name: '..', is_dir: true }),
    entry({ name: 'sub', is_dir: true, size: 0, modified: 10 }),
    entry({ name: 'a.txt', size: 200, modified: 20 }),
    entry({ name: '.hidden', size: 100, modified: 40 }),
  ];

  it('leads with .. whatever the sort says', () => {
    expect(names(visibleEntries(rows, view()))[0]).toBe('..');
    expect(names(visibleEntries(rows, view({ sortAsc: false })))[0]).toBe('..');
  });

  it('puts directories first when asked, and mixes them in when not', () => {
    expect(names(visibleEntries(rows, view()))).toEqual(['..', 'sub', 'a.txt', 'b.txt']);
    expect(names(visibleEntries(rows, view({ dirsOnTop: false })))).toEqual(['..', 'a.txt', 'b.txt', 'sub']);
  });

  it('turns the order round without moving .. or the directory rule', () => {
    expect(names(visibleEntries(rows, view({ sortAsc: false })))).toEqual(['..', 'sub', 'b.txt', 'a.txt']);
  });

  it('sorts on each column', () => {
    expect(names(visibleEntries(rows, view({ sortCol: 'Size', dirsOnTop: false }))))
      .toEqual(['..', 'sub', 'a.txt', 'b.txt']);
    expect(names(visibleEntries(rows, view({ sortCol: 'Date Modified', dirsOnTop: false }))))
      .toEqual(['..', 'sub', 'a.txt', 'b.txt']);
  });

  it('hides dotfiles until asked, and .. is never hidden', () => {
    expect(names(visibleEntries(rows, view()))).not.toContain('.hidden');
    expect(names(visibleEntries(rows, view({ showHidden: true })))).toContain('.hidden');
  });

  it('filters on the name, whatever its case, keeping ..', () => {
    expect(names(visibleEntries(rows, view({ filter: 'A.T' })))).toEqual(['..', 'a.txt']);
    expect(names(visibleEntries(rows, view({ filter: 'nothing' })))).toEqual(['..']);
  });
});

describe('formatSize', () => {
  it('says nothing about a directory and counts bytes for everything else', () => {
    expect(formatSize(0, true)).toBe('- -');
    expect(formatSize(0, false)).toBe('0 B');
    expect(formatSize(512, false)).toBe('512 B');
    expect(formatSize(1536, false)).toBe('1.5 KB');
    expect(formatSize(5 * 1024 ** 4, false)).toBe('5.0 TB');
    // Past the last unit it stays in it rather than running off the end.
    expect(formatSize(5 * 1024 ** 5, false)).toBe('5120.0 TB');
  });
});

describe('formatDate', () => {
  it('has nothing to show for a time nobody knows', () => {
    expect(formatDate(null)).toBe('- -');
    expect(formatDate(0)).toBe('- -');
  });

  it('shows a real time rather than a dash', () => {
    expect(formatDate(1_700_000_000)).not.toBe('- -');
  });
});
