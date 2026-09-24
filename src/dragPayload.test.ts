import { describe, expect, it } from 'vitest';
import { fileDragPayload, readDragPayload, readTabDrag, tabDragPayload } from './dragPayload';
import type { FileEntry } from './types';

const file = (name: string): FileEntry => ({
  name, path: `/x/${name}`, is_dir: false, size: 1, modified: 0, hidden: false,
  permissions: '-rw-r--r--', mode: 0o644, uid: 0, gid: 0, owner: 'root',
  kind: 'file', symlink: false,
});

describe('a dragged tab', () => {
  it('reads back the tab it named', () => {
    expect(readTabDrag(tabDragPayload('t1'))).toBe('t1');
  });

  it('is not a file drag, and a file drag is not it', () => {
    expect(readTabDrag(fileDragPayload('left', [file('a')]))).toBeNull();
    expect(readDragPayload(tabDragPayload('t1'))).toBeNull();
  });
});

describe('dragged files', () => {
  it('read back with the side they came from', () => {
    expect(readDragPayload(fileDragPayload('right', [file('a'), file('b')])))
      .toMatchObject({ fromSide: 'right', dropped: [{ name: 'a' }, { name: 'b' }] });
  });

  it('are nothing when nothing was dragged', () => {
    expect(readDragPayload(fileDragPayload('left', []))).toBeNull();
  });
});

describe('a drop from somewhere else', () => {
  it('is none of ours, whatever it carries', () => {
    expect(readTabDrag('')).toBeNull();
    expect(readDragPayload('')).toBeNull();
    expect(readTabDrag('/home/aalman/notes.txt')).toBeNull();
    expect(readDragPayload('<html>a page</html>')).toBeNull();
    // Valid JSON that is not a payload of ours.
    expect(readDragPayload('[1,2,3]')).toBeNull();
    expect(readTabDrag('"just a string"')).toBeNull();
    expect(readDragPayload('{"side":"left"}')).toBeNull();
  });
});
