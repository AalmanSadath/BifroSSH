/**
 * The monitor bar's arithmetic: whether it shows, and what two readings of a
 * host say about it.
 *
 * Pure, so it is tested without a host. The readings are the raw counters
 * `hoststats.rs` returns; a rate needs two of them.
 */

import type { Server } from './types';

/** Whether a tab on this host shows the bar. A quick connection has no host and follows the setting. */
export function monitorWanted(setting: boolean, host?: Pick<Server, 'monitor'> | null): boolean {
  return host?.monitor ?? setting;
}
