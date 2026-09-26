import { describe, expect, it } from 'vitest';
import { readCommand, remember, worthRemembering, type RowSource } from './commandHistory';

/** Rows as a terminal would hold them, `+` marking one that wrapped on from the last. */
function rows(...lines: string[]): RowSource {
  return {
    text: (row, column) => lines[row]?.replace(/^\+/, '').slice(column),
    wrapped: (row) => lines[row]?.startsWith('+') ?? false,
  };
}

describe('readCommand', () => {
  it('reads from the end of the prompt to the end of the line', () => {
    expect(readCommand(rows('user@box:~$ ls -la /tmp   ', 'output'), 0, 12)).toBe('ls -la /tmp');
  });

  it('follows a command that wrapped onto further rows', () => {
    expect(readCommand(rows('$ echo aaaa', '+bbbb', '+cc', 'output'), 0, 2)).toBe('echo aaaabbbbcc');
  });

  it('stops at a row that did not wrap', () => {
    expect(readCommand(rows('$ ls', 'file-one'), 0, 2)).toBe('ls');
  });

  it('is empty when nothing was typed', () => {
    expect(readCommand(rows('$ ', ''), 0, 2)).toBe('');
  });
});

describe('worthRemembering', () => {
  it('keeps an ordinary command', () => {
    expect(worthRemembering('ls -la')).toBe(true);
  });

  it('leaves out a command typed with a leading space, as shells do', () => {
    expect(worthRemembering(' export TOKEN=abc')).toBe(false);
  });

  it('leaves out nothing at all, and a pasted script', () => {
    expect(worthRemembering('')).toBe(false);
    expect(worthRemembering('x'.repeat(1001))).toBe(false);
  });
});

describe('remember', () => {
  it('puts the newest first and moves a repeat up instead of keeping two', () => {
    expect(remember(['ls', 'df -h'], 'uptime')).toEqual(['uptime', 'ls', 'df -h']);
    expect(remember(['ls', 'df -h'], 'df -h')).toEqual(['df -h', 'ls']);
  });

  it('drops the oldest past the cap', () => {
    expect(remember(['b', 'c'], 'a', 2)).toEqual(['a', 'b']);
  });
});
