import { describe, expect, it } from 'vitest';
import { transcriptLines, transcriptName, transcriptText, type BufferLike } from './transcript';

/** A buffer of rows; a row starting with `>` is a wrap of the one above. */
function buffer(rows: string[]): BufferLike {
  const lines = rows.map((row) => ({
    isWrapped: row.startsWith('>'),
    translateToString: (trimRight?: boolean) => {
      const text = row.startsWith('>') ? row.slice(1) : row;
      return trimRight ? text.trimEnd() : text;
    },
  }));
  return { length: lines.length, getLine: (i) => lines[i] };
}

describe('transcriptLines', () => {
  it('joins a line the window had to wrap', () => {
    expect(transcriptLines(buffer(['$ echo one', 'a very long ', '>line indeed', '$ '])))
      .toEqual(['$ echo one', 'a very long line indeed', '$']);
  });

  it('reads from the start of the scrollback, not the top of the screen', () => {
    expect(transcriptLines(buffer(['old', 'newer', 'newest']))).toHaveLength(3);
  });

  it('keeps a blank line between output', () => {
    expect(transcriptLines(buffer(['one', '', 'two']))).toEqual(['one', '', 'two']);
  });
});

describe('transcriptText', () => {
  it('drops the empty rows below the last output and ends with one newline', () => {
    expect(transcriptText(['one', 'two', '', '   ', ''])).toBe('one\ntwo\n');
  });

  it('is empty for a terminal nothing has been written to', () => {
    expect(transcriptText(['', '', ''])).toBe('');
    expect(transcriptText([])).toBe('');
  });

  it('keeps blank lines that have output under them', () => {
    expect(transcriptText(['one', '', 'two'])).toBe('one\n\ntwo\n');
  });
});

describe('transcriptName', () => {
  it('names the host and when it was taken', () => {
    expect(transcriptName('web01', new Date(2026, 8, 24, 15, 30, 5))).toBe('web01_20260924-153005.txt');
  });

  it('keeps a free-text name out of the path', () => {
    expect(transcriptName('prod / db "1"', new Date(2026, 0, 2, 3, 4, 5)))
      .toBe('prod___db__1__20260102-030405.txt');
    expect(transcriptName('../../etc', new Date(2026, 0, 2, 3, 4, 5)))
      .toBe('__.._etc_20260102-030405.txt');
    expect(transcriptName('', new Date(2026, 0, 2, 3, 4, 5))).toBe('session_20260102-030405.txt');
  });
});
