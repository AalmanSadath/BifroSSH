import { describe, expect, it } from 'vitest';
import { parseOctal, toOctal } from './PermissionsDialog';

describe('parseOctal', () => {
  it('reads a plain three digit mode', () => {
    expect(parseOctal('644')).toBe(0o644);
    expect(parseOctal('755')).toBe(0o755);
    expect(parseOctal('000')).toBe(0);
  });

  it('reads a leading sticky/setuid/setgid digit too', () => {
    expect(parseOctal('1777')).toBe(0o1777);
    expect(parseOctal('4755')).toBe(0o4755);
  });

  it('trims surrounding whitespace', () => {
    expect(parseOctal(' 644 ')).toBe(0o644);
  });

  it('rejects anything not one to four octal digits', () => {
    expect(parseOctal('')).toBeNull();
    expect(parseOctal('888')).toBeNull();
    expect(parseOctal('64a')).toBeNull();
    expect(parseOctal('12345')).toBeNull();
    expect(parseOctal('-1')).toBeNull();
  });
});

describe('toOctal', () => {
  it('pads to three digits', () => {
    expect(toOctal(0o644)).toBe('644');
    expect(toOctal(0)).toBe('000');
    expect(toOctal(0o7)).toBe('007');
  });

  it('does not pad a fourth digit away', () => {
    expect(toOctal(0o1777)).toBe('1777');
  });

  it('masks off anything outside the permission bits', () => {
    expect(toOctal(0o100644)).toBe('644');
  });

  it('round trips with parseOctal', () => {
    for (const mode of [0o644, 0o755, 0o600, 0o1777, 0]) {
      expect(parseOctal(toOctal(mode))).toBe(mode);
    }
  });
});
