import { describe, expect, it } from 'vitest';
import { screenSnapshot } from './screenSnapshot';

const source = (rows: string[], top = 0, cursorX = 0, cursorY = 0) => ({
  rows: 4,
  top,
  cursorX,
  cursorY,
  line: (row: number) => rows[row],
});

describe('screenSnapshot', () => {
  it('writes the visible rows and puts the cursor back', () => {
    expect(screenSnapshot(source(['old', '$ ls', 'a  b', '$ ', '', ''], 1, 2, 2))).toBe('$ ls\r\na  b\r\n$\x1b[3;3H');
  });

  it('is empty for an empty screen', () => {
    expect(screenSnapshot(source(['', '  ']))).toBe('');
  });
});
