import { afterEach, describe, expect, it } from 'vitest';
import { localStyle, posix, setLocalPlatform, styleFor, windows } from './paths';

afterEach(() => setLocalPlatform('linux'));

describe('posix', () => {
  it('walks up until there is nowhere left', () => {
    expect(posix.parent('/home/a/x.txt')).toBe('/home/a');
    expect(posix.parent('/home')).toBe('/');
    expect(posix.parent('/')).toBeNull();
  });

  it('joins with exactly one separator, at the root too', () => {
    expect(posix.join('/', 'x')).toBe('/x');
    expect(posix.join('/home/a', 'x')).toBe('/home/a/x');
    expect(posix.join('/home/a/', 'x')).toBe('/home/a/x');
  });

  it('breadcrumbs each navigate to themselves', () => {
    expect(posix.segments('/home/a')).toEqual([
      { label: 'home', path: '/home' },
      { label: 'a', path: '/home/a' },
    ]);
    expect(posix.segments('/')).toEqual([]);
  });

  it('takes the last segment off', () => {
    expect(posix.basename('/home/a/x.bfx')).toBe('x.bfx');
    expect(posix.basename('/home/a/')).toBe('a');
    expect(posix.basename('/')).toBe('');
  });

  it('knows the root', () => {
    expect(posix.isRoot('/')).toBe(true);
    expect(posix.isRoot('/home')).toBe(false);
  });
});

describe('windows', () => {
  /**
   * The reason this module exists. Rename derived the parent with
   * lastIndexOf('/'), which is -1 on a backslash path, so the new name landed
   * at the root of the disk instead of beside the file.
   */
  it('gives a file its own folder as the parent', () => {
    expect(windows.parent('C:\\Users\\a\\notes.txt')).toBe('C:\\Users\\a');
    expect(windows.join(windows.parent('C:\\Users\\a\\notes.txt')!, 'new.txt'))
      .toBe('C:\\Users\\a\\new.txt');
  });

  it('stops at the drive rather than walking off it', () => {
    expect(windows.parent('C:\\Users')).toBe('C:\\');
    expect(windows.parent('C:\\')).toBeNull();
    expect(windows.isRoot('C:\\')).toBe(true);
    expect(windows.isRoot('C:\\Users')).toBe(false);
  });

  it('treats a UNC share as its own root', () => {
    expect(windows.parent('\\\\srv\\pub\\docs')).toBe('\\\\srv\\pub\\');
    expect(windows.parent('\\\\srv\\pub\\')).toBeNull();
    expect(windows.isRoot('\\\\srv\\pub\\')).toBe(true);
  });

  it('joins without doubling the separator at a root', () => {
    expect(windows.join('C:\\', 'x')).toBe('C:\\x');
    expect(windows.join('C:\\Users', 'x')).toBe('C:\\Users\\x');
    expect(windows.join('\\\\srv\\pub\\', 'x')).toBe('\\\\srv\\pub\\x');
  });

  it('makes the drive a crumb of its own', () => {
    expect(windows.segments('C:\\Users\\a')).toEqual([
      { label: 'C:', path: 'C:\\' },
      { label: 'Users', path: 'C:\\Users' },
      { label: 'a', path: 'C:\\Users\\a' },
    ]);
  });

  /** Win32 accepts either separator, so a path can arrive with the wrong one. */
  it('reads a forward-slash Windows path and writes it back correctly', () => {
    expect(windows.parent('C:/Users/a/x.txt')).toBe('C:\\Users\\a');
    expect(windows.segments('C:/Users')).toEqual([
      { label: 'C:', path: 'C:\\' },
      { label: 'Users', path: 'C:\\Users' },
    ]);
  });

  it('takes the last segment off, and nothing off a root', () => {
    expect(windows.basename('C:\\Users\\a\\x.bfx')).toBe('x.bfx');
    expect(windows.basename('C:\\Users\\a\\')).toBe('a');
    expect(windows.basename('C:\\')).toBe('');
    expect(windows.basename('\\\\srv\\pub\\')).toBe('');
  });

  /** A path naming no volume is not a path we can walk. */
  it('refuses to invent a root', () => {
    expect(windows.parent('Users\\a')).toBeNull();
    expect(windows.segments('Users\\a')).toEqual([]);
  });
});

describe('the platform switch', () => {
  it('picks the style from the platform string', () => {
    setLocalPlatform('windows');
    expect(localStyle()).toBe(windows);
    setLocalPlatform('linux');
    expect(localStyle()).toBe(posix);
    setLocalPlatform('macos');
    expect(localStyle()).toBe(posix);
  });

  /** Remote paths are POSIX whatever this machine runs. */
  it('leaves the remote side alone on Windows', () => {
    setLocalPlatform('windows');
    expect(styleFor('remote')).toBe(posix);
    expect(styleFor('local')).toBe(windows);
  });
});
