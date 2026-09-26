/**
 * The monitor bar's arithmetic: whether it shows, and what two readings of a
 * host say about it.
 *
 * Pure, so it is tested without a host. The readings are the raw counters
 * `hoststats.rs` returns; a rate needs two of them.
 */

import type { HostSample, Server } from './types';

/**
 * The error a host without Linux's /proc answers with, word for word as
 * `hoststats.rs` says it: the bar stops asking once it has seen it.
 */
export const NOT_LINUX = 'This host has no Linux /proc to read';

/** Whether a tab on this host shows the bar. A quick connection has no host and follows the setting. */
export function monitorWanted(setting: boolean, host?: Pick<Server, 'monitor'> | null): boolean {
  return host?.monitor ?? setting;
}

/** What two readings a few seconds apart say. Null where it cannot be told yet. */
export interface Rates {
  cpuPercent: number | null;
  rxPerSec: number | null;
  txPerSec: number | null;
}

/**
 * CPU use and network speed between two readings.
 *
 * Null for the first reading, and for any counter that went backwards: a host
 * that rebooted, or a counter that wrapped, would otherwise show a negative
 * rate, or an enormous one.
 */
export function rates(prev: HostSample | null, cur: HostSample, seconds: number): Rates {
  if (!prev || seconds <= 0) return { cpuPercent: null, rxPerSec: null, txPerSec: null };
  const total = cur.cpu_total - prev.cpu_total;
  const idle = cur.cpu_idle - prev.cpu_idle;
  const cpuPercent = total > 0 && idle >= 0 && idle <= total ? ((total - idle) / total) * 100 : null;
  const per = (a: number | null, b: number | null) =>
    a !== null && b !== null && b >= a ? (b - a) / seconds : null;
  return {
    cpuPercent,
    rxPerSec: per(prev.net_rx, cur.net_rx),
    txPerSec: per(prev.net_tx, cur.net_tx),
  };
}

/** Memory in use: what is not available, which counts cache the kernel would give back as free. */
export function memPercent(s: HostSample): number | null {
  return s.mem_total > 0 ? ((s.mem_total - s.mem_available) / s.mem_total) * 100 : null;
}

export function diskPercent(s: HostSample): number | null {
  return s.disk_used !== null && s.disk_size ? (s.disk_used / s.disk_size) * 100 : null;
}

export type Level = 'ok' | 'warn' | 'high';

/** How worried a figure should look: from three quarters, and from nine tenths. */
export function level(percent: number | null): Level {
  if (percent === null || percent < 75) return 'ok';
  return percent < 90 ? 'warn' : 'high';
}
