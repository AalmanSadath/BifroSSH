import { describe, expect, it } from 'vitest';
import { bookmarksFor, isBookmarked, labelFor } from './bookmarks';
import { posix, windows } from './paths';
import type { SftpBookmark } from './types';

const bm = (id: string, server_id: string | null, label: string, path: string): SftpBookmark =>
  ({ id, server_id, label, path });

const list = [
  bm('1', 'pi', 'log', '/var/log'),
  bm('2', null, 'tmp', '/tmp'),
  bm('3', 'pi', 'etc', '/etc'),
  bm('4', 'web', 'etc', '/etc'),
];

describe('bookmarksFor', () => {
  it('keeps one pane\u2019s own, in label order', () => {
    expect(bookmarksFor(list, 'pi').map((b) => b.id)).toEqual(['3', '1']);
    expect(bookmarksFor(list, null).map((b) => b.id)).toEqual(['2']);
    expect(bookmarksFor(list, 'nobody')).toEqual([]);
  });
});

describe('isBookmarked', () => {
  it('is about this pane and this exact path', () => {
    expect(isBookmarked(list, 'pi', '/var/log')).toBe(true);
    expect(isBookmarked(list, 'web', '/var/log')).toBe(false);
    expect(isBookmarked(list, null, '/var/log')).toBe(false);
    expect(isBookmarked(list, 'pi', '/var/log/')).toBe(false);
  });
});

describe('labelFor', () => {
  it('is the last segment, or the path at a root', () => {
    expect(labelFor('/var/log', posix)).toBe('log');
    expect(labelFor('/', posix)).toBe('/');
    expect(labelFor('C:\\Users\\me', windows)).toBe('me');
    expect(labelFor('C:\\', windows)).toBe('C:\\');
  });
});
