/**
 * How the hosts page narrows and sections its cards. Pure, so it can be
 * tested without a store.
 */

import type { Server, SessionTab } from './types';

/** The chip that shows hosts with no group. Also the key used for it. */
export const UNGROUPED = 'Ungrouped';

export interface HostSection {
  /** The group's name, or null for the hosts without one. */
  group: string | null;
  servers: Server[];
}

/** A host's group as it is shown: trimmed, and null when blank. */
export function groupOf(server: Server): string | null {
  const g = server.group?.trim() ?? '';
  return g === '' ? null : g;
}

/** Every group in use, in name order. */
export function groupNames(servers: Server[]): string[] {
  const names = new Set<string>();
  for (const s of servers) {
    const g = groupOf(s);
    if (g !== null) names.add(g);
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b));
}

/**
 * Whether the host matches a search box. Case-insensitive, across the
 * things a person remembers a host by: its name, address, user, group and
 * whatever was written in its notes.
 */
export function matchesHost(server: Server, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (q === '') return true;
  return [server.name, server.host, server.username ?? '', groupOf(server) ?? '', server.notes ?? '']
    .some((field) => field.toLowerCase().includes(q));
}

/**
 * The cards to show, grouped and in order.
 *
 * Groups in name order, each with its hosts in name order; hosts with no
 * group come last. `groupFilter` keeps one group only (`UNGROUPED` for the
 * hosts without one); null keeps all. An empty section is not returned.
 */
export function hostSections(
  servers: Server[],
  query: string,
  groupFilter: string | null,
): HostSection[] {
  const byName = (a: Server, b: Server) => a.name.localeCompare(b.name);
  const kept = servers.filter((s) => matchesHost(s, query));

  const sections: HostSection[] = [];
  for (const group of groupNames(servers)) {
    if (groupFilter !== null && groupFilter !== group) continue;
    const members = kept.filter((s) => groupOf(s) === group).sort(byName);
    if (members.length > 0) sections.push({ group, servers: members });
  }
  if (groupFilter === null || groupFilter === UNGROUPED) {
    const loose = kept.filter((s) => groupOf(s) === null).sort(byName);
    if (loose.length > 0) sections.push({ group: null, servers: loose });
  }
  return sections;
}

/** What a host card's dot says. */
export type HostStatus = 'connected' | 'connecting' | 'error' | 'off';

/**
 * The state of a host across every tab open on it.
 *
 * An open tab is not a connection: a tab stays in the strip after it failed,
 * and after its connection dropped, so that its scrollback and its reason are
 * still there. Green therefore needs a tab that is actually connected. With
 * several tabs, the best one wins: one working session means the host is up,
 * whatever a second tab is still trying to do, and a tab mid-connect or
 * mid-reconnect outranks one that has given up.
 */
export function hostStatus(tabs: Pick<SessionTab, 'status' | 'reconnecting'>[]): HostStatus {
  if (tabs.some((t) => t.status === 'connected')) return 'connected';
  if (tabs.some((t) => t.status === 'connecting' || (t.status === 'dropped' && t.reconnecting))) {
    return 'connecting';
  }
  if (tabs.some((t) => t.status === 'error' || t.status === 'dropped')) return 'error';
  return 'off';
}
