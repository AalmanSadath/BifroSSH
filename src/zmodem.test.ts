import { describe, expect, it } from 'vitest';
import { baseName, toBase64 } from './zmodem';

describe('toBase64', () => {
  it('encodes bytes the way the backend decodes them', () => {
    expect(toBase64(new Uint8Array([104, 105]))).toBe('aGk=');
    expect(toBase64(new Uint8Array([0, 255, 24, 42]))).toBe('AP8YKg==');
  });

  /** A file chunk is far longer than one call to fromCharCode can take. */
  it('encodes a chunk larger than the argument limit', () => {
    const big = new Uint8Array(200_000).fill(65);
    expect(atob(toBase64(big)).length).toBe(200_000);
  });
});

describe('baseName', () => {
  it('names a file whichever separator the path uses', () => {
    expect(baseName('/home/me/report.pdf')).toBe('report.pdf');
    expect(baseName('C:\\Users\\me\\notes.txt')).toBe('notes.txt');
    expect(baseName('plain')).toBe('plain');
  });
});
