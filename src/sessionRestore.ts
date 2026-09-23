/**
 * Which tabs are worth writing down, and which of those are worth opening
 * again. Pure, so it can be tested without a store or a connection.
 */

import type { Server, SessionTab } from './types';

/**
 * The hosts to record, in strip order.
 *
 * Quick connections are left out: they are `server_id: ''`, their credentials
 * were never saved, and reopening one could only produce a prompt for a host
 * the app cannot name. A tab that failed to connect is left out too, since
 * restoring it would reproduce the failure and nothing else.
 */
export function tabsToSave(sessions: SessionTab[]): string[] {
  return sessions
    .filter((t) => t.server_id !== '' && t.status !== 'error')
    .map((t) => t.server_id);
}

/**
 * The recorded hosts that still exist, in the order they were recorded.
 *
 * A host deleted since the last run would otherwise open an error tab on
 * every launch, for a record the user removed on purpose.
 */
export function restoreOrder(ids: string[], servers: Server[]): string[] {
  const known = new Set(servers.map((s) => s.id));
  return ids.filter((id) => known.has(id));
}
