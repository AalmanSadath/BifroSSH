import { afterEach, describe, expect, it } from 'vitest';
import { localStyle, posix, resolveTyped, setLocalPlatform, styleFor, windows } from './paths';

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

describe('a typed path', () => {
  const home = '/home/a';

  it('is nothing when blank', () => {
    expect(resolveTyped('', '/x', home, posix)).toBeNull();
    expect(resolveTyped('   ', '/x', home, posix)).toBeNull();
  });

  it('from the root is taken as it is', () => {
    expect(resolveTyped('/var/log', '/home/a', home, posix)).toBe('/var/log');
    expect(resolveTyped(' /var/log ', '/home/a', home, posix)).toBe('/var/log');
  });

  it('otherwise joins onto where the pane is', () => {
    expect(resolveTyped('nginx', '/var/log', home, posix)).toBe('/var/log/nginx');
    expect(resolveTyped('a/b', '/', home, posix)).toBe('/a/b');
    // Left for the listing to resolve, the way the server would.
    expect(resolveTyped('..', '/var/log', home, posix)).toBe('/var/log/..');
  });

  it('expands ~ to the home, when one is known', () => {
    expect(resolveTyped('~', '/x', home, posix)).toBe('/home/a');
    expect(resolveTyped('~/Downloads', '/x', home, posix)).toBe('/home/a/Downloads');
    expect(resolveTyped('~', '/x', null, posix)).toBeNull();
    expect(resolveTyped('~/Downloads', '/x', null, posix)).toBeNull();
  });

  it('does not mistake a name starting with ~ for the home', () => {
    expect(resolveTyped('~backup', '/x', home, posix)).toBe('/x/~backup');
  });

  it('drops a trailing separator, except off a root', () => {
    expect(resolveTyped('/var/log/', '/', home, posix)).toBe('/var/log');
    expect(resolveTyped('/', '/x', home, posix)).toBe('/');
    expect(resolveTyped('C:\\Users\\a\\', 'C:\\', 'C:\\Users\\a', windows)).toBe('C:\\Users\\a');
    expect(resolveTyped('C:\\', 'C:\\Users', 'C:\\Users\\a', windows)).toBe('C:\\');
  });

  it('on Windows takes a drive or UNC root as absolute and writes backslashes', () => {
    const h = 'C:\\Users\\a';
    expect(resolveTyped('D:\\data', 'C:\\Users', h, windows)).toBe('D:\\data');
    expect(resolveTyped('C:/Users/a/Documents', 'C:\\', h, windows)).toBe('C:\\Users\\a\\Documents');
    expect(resolveTyped('\\\\server\\share\\dir', 'C:\\', h, windows)).toBe('\\\\server\\share\\dir');
    expect(resolveTyped('Documents', 'C:\\Users\\a', h, windows)).toBe('C:\\Users\\a\\Documents');
    expect(resolveTyped('~\\Documents', 'C:\\', h, windows)).toBe('C:\\Users\\a\\Documents');
  });
});
