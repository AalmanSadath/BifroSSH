import { describe, expect, it } from 'vitest';
import { diskPercent, level, memPercent, monitorWanted, rates } from './hostStats';
import type { HostSample } from './types';

describe('monitorWanted', () => {
  it('follows the setting for a host left on Default, and for a quick connection', () => {
    expect(monitorWanted(true, { monitor: null })).toBe(true);
    expect(monitorWanted(false, { monitor: undefined })).toBe(false);
    expect(monitorWanted(true, undefined)).toBe(true);
  });

  it('lets a host say Always or Never whatever the setting is', () => {
    expect(monitorWanted(false, { monitor: true })).toBe(true);
    expect(monitorWanted(true, { monitor: false })).toBe(false);
  });
});

const sample = (over: Partial<HostSample> = {}): HostSample => ({
  cpu_total: 1000,
  cpu_idle: 800,
  mem_total: 4000,
  mem_available: 1000,
  load1: 0.5,
  net_rx: 10_000,
  net_tx: 5_000,
  disk_used: 450,
  disk_size: 1000,
  ...over,
});

describe('rates', () => {
  it('has nothing to say from one reading', () => {
    expect(rates(null, sample(), 3)).toEqual({ cpuPercent: null, rxPerSec: null, txPerSec: null });
  });

  it('works out CPU use and network speed between two', () => {
    const r = rates(sample(), sample({ cpu_total: 1100, cpu_idle: 830, net_rx: 13_000, net_tx: 5_600 }), 3);
    expect(r.cpuPercent).toBeCloseTo(70);
    expect(r.rxPerSec).toBe(1000);
    expect(r.txPerSec).toBe(200);
  });

  it('says nothing rather than a negative rate after a reboot', () => {
    const r = rates(sample(), sample({ cpu_total: 50, cpu_idle: 40, net_rx: 10, net_tx: 10 }), 3);
    expect(r).toEqual({ cpuPercent: null, rxPerSec: null, txPerSec: null });
  });

  it('leaves the network out on a host that did not report it', () => {
    const r = rates(sample({ net_rx: null, net_tx: null }), sample({ net_rx: null, net_tx: null }), 3);
    expect(r.rxPerSec).toBeNull();
  });
});

describe('memPercent and diskPercent', () => {
  it('counts memory that is not available as used', () => {
    expect(memPercent(sample())).toBe(75);
  });

  it('reads the disk, or nothing when there was no df line', () => {
    expect(diskPercent(sample())).toBe(45);
    expect(diskPercent(sample({ disk_used: null, disk_size: null }))).toBeNull();
  });
});

describe('level', () => {
  it('worries from three quarters, and more from nine tenths', () => {
    expect(level(null)).toBe('ok');
    expect(level(74.9)).toBe('ok');
    expect(level(75)).toBe('warn');
    expect(level(90)).toBe('high');
  });
});
