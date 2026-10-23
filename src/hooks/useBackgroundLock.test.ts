import { describe, expect, it } from 'vitest';
import { backgroundDue } from './useBackgroundLock';

const MIN = 60_000;

describe('backgroundDue', () => {
  it('is never due when the setting is off', () => {
    expect(backgroundDue(0, 999 * MIN, null)).toBe(false);
  });

  it('is never due without a time the app was hidden', () => {
    expect(backgroundDue(null, 999 * MIN, 0)).toBe(false);
  });

  it('locks on every return at 0', () => {
    expect(backgroundDue(5 * MIN, 5 * MIN, 0)).toBe(true);
  });

  it('is due once the time away reaches the setting, and not before', () => {
    expect(backgroundDue(0, MIN - 1, 1)).toBe(false);
    expect(backgroundDue(0, MIN, 1)).toBe(true);
  });
});
