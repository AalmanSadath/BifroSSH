/**
 * How a reachability check reads on a host card. Pure, so the wording and
 * the colour can be tested without a network.
 */

import type { HostProbe, ProbeState } from './types';

/** How long a result is worth showing before it is stale rather than wrong. */
export const PROBE_TTL_MS = 5 * 60 * 1000;

/** A round trip, in the unit that suits it. */
export function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * The short text beside the address, or null when there is nothing to say
 * yet. Null is the card exactly as it was before anyone asked.
 */
export function probeLabel(state: ProbeState | undefined): string | null {
  if (state === undefined) return null;
  if (state === 'running') return 'checking…';
  if (state === 'skipped') return 'behind a jump host';
  return state.reachable ? formatLatency(state.ms) : 'unreachable';
}

/** The modifier class that colours that text. */
export function probeClass(state: ProbeState | undefined): string {
  if (state === undefined || state === 'running' || state === 'skipped') return '';
  return state.reachable ? ' host-probe-ok' : ' host-probe-bad';
}

/**
 * What the hover says: the error when there was one, since "unreachable"
 * alone does not distinguish a wrong port from a wrong name.
 */
export function probeTitle(state: ProbeState | undefined): string | undefined {
  if (state === undefined || state === 'running') return undefined;
  if (state === 'skipped') {
    return 'Not checked: reaching this host means connecting to its jump host first, which would need its credentials.';
  }
  if (state.reachable) return `Answered in ${formatLatency(state.ms)}.`;
  return state.error ?? 'No answer.';
}

/**
 * Whether this host is worth asking about. A check already in flight is not,
 * or pressing the button twice would dial everything twice.
 */
export function isStale(state: ProbeState | undefined, now: number): boolean {
  if (state === undefined) return true;
  if (state === 'running' || state === 'skipped') return false;
  return now - state.at > PROBE_TTL_MS;
}

/** The shape stored per host, with when it landed. */
export type Probed = HostProbe & { at: number };
