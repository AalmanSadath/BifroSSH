import { afterEach, describe, expect, it } from 'vitest';
import { applyLatch, ctrlOf, getLatch, toggleLatch } from './keyLatch';

afterEach(() => {
  if (getLatch().ctrl) toggleLatch('ctrl');
  if (getLatch().alt) toggleLatch('alt');
});

describe('ctrlOf', () => {
  it('makes control characters of letters either case', () => {
    expect(ctrlOf('c')).toBe('\x03');
    expect(ctrlOf('C')).toBe('\x03');
    expect(ctrlOf('a')).toBe('\x01');
  });

  it('knows the punctuation a terminal maps', () => {
    expect(ctrlOf('[')).toBe('\x1b');
    expect(ctrlOf(' ')).toBe('\x00');
    expect(ctrlOf('?')).toBe('\x7f');
  });

  it('has nothing for a digit', () => {
    expect(ctrlOf('5')).toBeNull();
  });
});

describe('applyLatch', () => {
  it('passes typing through when nothing is latched', () => {
    expect(applyLatch('ls')).toBe('ls');
  });

  it('applies Ctrl to the next character, once', () => {
    toggleLatch('ctrl');
    expect(applyLatch('c')).toBe('\x03');
    expect(applyLatch('c')).toBe('c');
  });

  it('puts Escape in front for Alt', () => {
    toggleLatch('alt');
    expect(applyLatch('b')).toBe('\x1bb');
  });

  it('combines Ctrl and Alt', () => {
    toggleLatch('ctrl');
    toggleLatch('alt');
    expect(applyLatch('x')).toBe('\x1b\x18');
  });

  it('releases Ctrl on a sequence without changing it', () => {
    toggleLatch('ctrl');
    expect(applyLatch('\x1b[A')).toBe('\x1b[A');
    expect(getLatch().ctrl).toBe(false);
  });
});
