import { describe, expect, it } from 'vitest';
import { newerVersion, pickAndroidRelease } from './updates';

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

describe('pickAndroidRelease', () => {
  const rel = (tag_name: string, extra: object = {}) =>
    ({ tag_name, html_url: `https://example/${tag_name}`, draft: false, prerelease: false, ...extra });

  it('takes the newest Android release and drops the prefix', () => {
    const list = [rel('v0.17.0'), rel('android-v0.2.0'), rel('android-v0.1.0')];
    expect(pickAndroidRelease(list)).toEqual({ version: '0.2.0', url: 'https://example/android-v0.2.0' });
  });

  it('skips drafts and pre-releases', () => {
    const list = [rel('android-v0.3.0', { draft: true }), rel('android-v0.2.1', { prerelease: true }), rel('android-v0.2.0')];
    expect(pickAndroidRelease(list)?.version).toBe('0.2.0');
  });

  it('is null with no Android release, or with something that is not a list', () => {
    expect(pickAndroidRelease([rel('v0.17.0'), rel('android-vnext')])).toBeNull();
    expect(pickAndroidRelease([])).toBeNull();
    expect(pickAndroidRelease({ message: 'rate limited' })).toBeNull();
  });
});
