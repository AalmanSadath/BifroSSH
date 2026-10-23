import * as ipc from '../../ipc';
import type { PortForwarding } from '../../types';
import { buildJumpChain, resolveServerAuth } from '../auth';
import { RETRY_FIRST_MS, RETRY_MAX_MS } from '../defaults';
import { persist } from '../persistence';
import type { AppStore, Slice } from '../types';

/** What just happened, for the tunnels that start on their own. */
export type AutostartTrigger = { kind: 'launch' } | { kind: 'connect'; serverId: string };

export interface TunnelsSlice {
  portForwardings: PortForwarding[];
  savePortForwarding: (pf: Omit<PortForwarding, 'id'> & { id?: string }) => void;
  deletePortForwarding: (id: string) => void;
  activeTunnelIds: Set<string>;
  /** Rules that dropped and are being started again, with backoff. */
  retryingTunnelIds: Set<string>;
  startTunnel: (pf: PortForwarding) => Promise<void>;
  stopTunnel: (pfId: string) => Promise<void>;
  /**
   * The backend said the tunnel died. A rule that starts on its own is
   * started again, 5s then doubling to a minute, until it comes up, the
   * user stops it, or the rule is gone. Any other rule just goes quiet.
   */
  tunnelDropped: (pfId: string) => void;
  /**
   * Starts every rule whose autostart flag matches the trigger and that is
   * not already running. Never throws: failures are gathered into one
   * banner, since the app has to come up whatever a tunnel does.
   */
  autostartTunnels: (trigger: AutostartTrigger) => Promise<void>;
  /**
   * Tries every retrying tunnel at once instead of when its backoff runs
   * out, for when the network has just come back or changed.
   */
  retryTunnelsNow: () => void;
}

/**
 * Which retry loop is current for each rule. Starting a loop takes the next
 * number; a loop that wakes to find a newer one has been replaced and stops,
 * so trying at once never leaves two loops racing.
 */
const tunnelRetryGen = new Map<string, number>();

/** Retries the rule after `firstMs`, then from 5s doubling to a minute. */
function retryTunnel(
  set: Parameters<Slice<TunnelsSlice>>[0],
  get: () => AppStore,
  pfId: string,
  firstMs: number,
) {
  const gen = (tunnelRetryGen.get(pfId) ?? 0) + 1;
  tunnelRetryGen.set(pfId, gen);
  const attempt = async (delayMs: number) => {
    await new Promise((r) => setTimeout(r, delayMs));
    if (tunnelRetryGen.get(pfId) !== gen) return;
    const { retryingTunnelIds, portForwardings, startTunnel } = get();
    // Deactivated meanwhile, or the rule was deleted: nothing to bring back.
    const rule = portForwardings.find((p) => p.id === pfId);
    if (!retryingTunnelIds.has(pfId) || !rule) return;
    try {
      await startTunnel(rule);
      set((s) => { const n = new Set(s.retryingTunnelIds); n.delete(pfId); return { retryingTunnelIds: n }; });
    } catch {
      attempt(Math.min(Math.max(delayMs * 2, RETRY_FIRST_MS), RETRY_MAX_MS));
    }
  };
  attempt(firstMs);
}

export const createTunnelsSlice: Slice<TunnelsSlice> = (set, get) => ({
  portForwardings: [],
  activeTunnelIds: new Set<string>(),
  retryingTunnelIds: new Set<string>(),

  savePortForwarding: (pf) => {
    set((s) => {
      const id = pf.id ?? crypto.randomUUID();
      const entry: PortForwarding = { ...pf, id };
      const exists = s.portForwardings.some((x) => x.id === id);
      const next = exists
        ? s.portForwardings.map((x) => (x.id === id ? entry : x))
        : [...s.portForwardings, entry];
      persist(get, () => ipc.savePortForwardings(next));
      return { portForwardings: next };
    });
  },

  deletePortForwarding: (id) => {
    set((s) => {
      const next = s.portForwardings.filter((x) => x.id !== id);
      persist(get, () => ipc.savePortForwardings(next));
      return { portForwardings: next };
    });
  },

  startTunnel: async (pf) => {
    const { servers, identities } = get();
    const serverId = pf.type === 'remote' ? pf.remote_host_id : pf.intermediate_host_id;
    if (!serverId) throw new Error('No server configured for this rule');
    const server = servers.find((s) => s.id === serverId);
    if (!server) throw new Error('Server not found');

    const resolved = await resolveServerAuth(server, identities);
    if (!resolved) throw new Error('No credentials configured for this server');
    const { username, authType, authValue } = resolved;

    await ipc.tunnelStart({
      pfId: pf.id,
      pfType: pf.type,
      bindAddress: pf.bind_address,
      localPort: pf.local_port,
      remotePort: pf.remote_port,
      destHost: pf.dest_address || null,
      destPort: pf.dest_port,
      serverId,
      username,
      authType,
      authValue,
      jumps: await buildJumpChain(server, servers, identities),
    });
    set((s) => ({ activeTunnelIds: new Set([...s.activeTunnelIds, pf.id]) }));
  },

  autostartTunnels: async (trigger) => {
    const { portForwardings, activeTunnelIds, startTunnel } = get();
    const wanted = portForwardings.filter((pf) => {
      if (activeTunnelIds.has(pf.id)) return false;
      if (trigger.kind === 'launch') return pf.autostart_on_launch;
      const host = pf.type === 'remote' ? pf.remote_host_id : pf.intermediate_host_id;
      return pf.autostart_on_connect && host === trigger.serverId;
    });
    const failures: string[] = [];
    for (const pf of wanted) {
      try {
        await startTunnel(pf);
      } catch (e) {
        failures.push(`${pf.label}: ${String(e)}`);
      }
    }
    if (failures.length > 0) {
      get().setActionError(`Could not start ${failures.length === 1 ? 'a tunnel' : 'some tunnels'}. ${failures.join(' · ')}`);
    }
  },

  stopTunnel: async (pfId) => {
    await ipc.tunnelStop(pfId);
    set((s) => {
      const active = new Set(s.activeTunnelIds); active.delete(pfId);
      const retrying = new Set(s.retryingTunnelIds); retrying.delete(pfId);
      return { activeTunnelIds: active, retryingTunnelIds: retrying };
    });
  },

  tunnelDropped: (pfId) => {
    const pf = get().portForwardings.find((p) => p.id === pfId);
    const retry = !!pf && (pf.autostart_on_launch || pf.autostart_on_connect);
    set((s) => {
      const active = new Set(s.activeTunnelIds); active.delete(pfId);
      const retrying = new Set(s.retryingTunnelIds);
      if (retry) retrying.add(pfId);
      return { activeTunnelIds: active, retryingTunnelIds: retrying };
    });
    if (!retry) return;

    get().setActionError(`Tunnel "${pf.label}" dropped. Trying again.`);
    retryTunnel(set, get, pfId, RETRY_FIRST_MS);
  },

  retryTunnelsNow: () => {
    for (const pfId of get().retryingTunnelIds) retryTunnel(set, get, pfId, 0);
  },
});
