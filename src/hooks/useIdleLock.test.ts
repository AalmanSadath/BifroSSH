import { describe, expect, it } from 'vitest';
import { idleDue } from './useIdleLock';

const MIN = 60_000;

describe('idleDue', () => {
  it('is never due when the timeout is off', () => {
    expect(idleDue(0, 999 * MIN, 0)).toBe(false);
  });

  it('is due once the gap reaches the timeout, and not before', () => {
    expect(idleDue(0, 5 * MIN - 1, 5)).toBe(false);
    expect(idleDue(0, 5 * MIN, 5)).toBe(true);
    expect(idleDue(0, 60 * MIN, 5)).toBe(true);
  });

  it('measures from the last activity, not from the start', () => {
    expect(idleDue(4 * MIN, 8 * MIN, 5)).toBe(false);
    expect(idleDue(4 * MIN, 9 * MIN, 5)).toBe(true);
  });
});
