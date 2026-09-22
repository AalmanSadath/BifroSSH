import { describe, expect, it } from 'vitest';
import { newerVersion } from './updates';

describe('newerVersion', () => {
  it('compares numerically, not as text', () => {
    expect(newerVersion('0.14.1', '0.15.0')).toBe(true);
    expect(newerVersion('0.9.0', '0.10.0')).toBe(true);
    expect(newerVersion('0.14.1', '1.0.0')).toBe(true);
    expect(newerVersion('0.14.1', '0.14.2')).toBe(true);
  });

  it('is false for the same or an older version', () => {
    expect(newerVersion('0.14.1', '0.14.1')).toBe(false);
    expect(newerVersion('0.15.0', '0.14.9')).toBe(false);
    expect(newerVersion('1.0.0', '0.99.99')).toBe(false);
  });

  it('accepts a leading v on either side', () => {
    expect(newerVersion('v0.14.1', '0.15.0')).toBe(true);
    expect(newerVersion('0.14.1', 'v0.15.0')).toBe(true);
  });

  it('never raises an alarm for a tag it cannot read', () => {
    expect(newerVersion('0.14.1', 'nightly')).toBe(false);
    expect(newerVersion('0.14.1', '')).toBe(false);
    expect(newerVersion('dev', '9.9.9')).toBe(false);
  });
});
