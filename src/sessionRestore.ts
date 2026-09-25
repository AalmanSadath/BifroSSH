/**
 * Which tabs are worth writing down, and which of those are worth opening
 * again. Pure, so it can be tested without a store or a connection.
 */

import type { OpenTab, Server, SessionTab } from './types';

/**
 * The tabs to record, in strip order, each with the name the user gave it.
 *
 * Quick connections are left out: they are `server_id: ''`, their credentials
 * were never saved, and reopening one could only produce a prompt for a host
 * the app cannot name. A tab that failed to connect is left out too, since
 * restoring it would reproduce the failure and nothing else.
 */
export function tabsToSave(sessions: SessionTab[]): OpenTab[] {
  return sessions
    .filter((t) => t.server_id !== '' && t.status !== 'error')
    .map((t) => (t.title ? { server_id: t.server_id, title: t.title } : { server_id: t.server_id }));
}

/**
 * The recorded tabs whose host still exists, in the order they were recorded.
 *
 * A host deleted since the last run would otherwise open an error tab on
 * every launch, for a record the user removed on purpose.
 */
export function restoreOrder(tabs: OpenTab[], servers: Server[]): OpenTab[] {
  const known = new Set(servers.map((s) => s.id));
  return tabs.filter((t) => known.has(t.server_id));
}
