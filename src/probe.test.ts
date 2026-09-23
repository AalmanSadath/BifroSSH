import { describe, expect, it } from 'vitest';
import { PROBE_TTL_MS, formatLatency, isStale, probeClass, probeLabel, probeTitle } from './probe';

const ok = { reachable: true, ms: 12, error: null, at: 1000 };
const bad = { reachable: false, ms: 0, error: 'Connection refused', at: 1000 };

describe('formatLatency', () => {
  it('reads in milliseconds, and in seconds once that is silly', () => {
    expect(formatLatency(12)).toBe('12 ms');
    expect(formatLatency(999)).toBe('999 ms');
    expect(formatLatency(1500)).toBe('1.5 s');
  });
});

describe('probeLabel', () => {
  it('says nothing until someone asks', () => {
    expect(probeLabel(undefined)).toBeNull();
  });

  it('names each state', () => {
    expect(probeLabel('running')).toBe('checking…');
    expect(probeLabel('skipped')).toBe('behind a jump host');
    expect(probeLabel(ok)).toBe('12 ms');
    expect(probeLabel(bad)).toBe('unreachable');
  });
});

describe('probeClass', () => {
  it('colours only a finished check', () => {
    expect(probeClass(undefined)).toBe('');
    expect(probeClass('running')).toBe('');
    expect(probeClass('skipped')).toBe('');
    expect(probeClass(ok)).toBe(' host-probe-ok');
    expect(probeClass(bad)).toBe(' host-probe-bad');
  });
});

describe('probeTitle', () => {
  it('hands the failure over, since "unreachable" does not say why', () => {
    expect(probeTitle(bad)).toBe('Connection refused');
    expect(probeTitle(ok)).toContain('12 ms');
    expect(probeTitle('skipped')).toContain('jump host');
    expect(probeTitle('running')).toBeUndefined();
  });
});

describe('isStale', () => {
  it('asks again for a host never checked, and for an old result', () => {
    expect(isStale(undefined, 0)).toBe(true);
    expect(isStale(ok, ok.at + PROBE_TTL_MS + 1)).toBe(true);
  });

  it('leaves a fresh result alone, and a check already in flight', () => {
    expect(isStale(ok, ok.at + 1000)).toBe(false);
    // Pressing the button twice must not dial everything twice.
    expect(isStale('running', 10_000_000)).toBe(false);
  });

  it('never re-asks about a host behind a jump, since nothing would be dialled', () => {
    expect(isStale('skipped', 10_000_000)).toBe(false);
  });
});
