import { describe, expect, it } from 'vitest';
import { longEnough } from './passphraseRules';

describe('longEnough', () => {
  it('wants twelve characters from a typed passphrase', () => {
    expect(longEnough('elevenchars')).toBe(false);
    expect(longEnough('twelve chars')).toBe(true);
  });

  it('counts characters the way the backend does, not UTF-16 units', () => {
    // Six emoji are twelve UTF-16 units but six characters.
    expect(longEnough('😀😀😀😀😀😀')).toBe(false);
  });

  it('passes a generated phrase whatever its length', () => {
    expect(longEnough('short', true)).toBe(true);
  });
});
