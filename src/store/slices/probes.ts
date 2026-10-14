import * as ipc from '../../ipc';
import { isStale, type Probed } from '../../probe';
import type { ProbeState } from '../../types';
import type { Slice } from '../types';

export interface ProbesSlice {
  /**
   * The last reachability check per host id, or that one is in flight.
   * Nothing probes on its own: this fills only when the user asks.
   */
  hostProbes: Record<string, ProbeState>;
  /**
   * Checks each host that has no fresh result. Hosts reached through a jump
   * host are marked skipped rather than dialled: that would mean connecting
   * to the bastion with its credentials, which a reachability check has no
   * business doing.
   */
  probeHosts: (ids: string[], force?: boolean) => Promise<void>;
}

export const createProbesSlice: Slice<ProbesSlice> = (set, get) => ({
  hostProbes: {},

  probeHosts: async (ids, force = false) => {
    const { servers, settings, hostProbes } = get();
    const now = Date.now();
    // Asked for by hand means asked again: a fresh result is skipped only
    // when something else wanted the numbers filled in.
    const todo = ids.filter((id) =>
      hostProbes[id] !== 'running' && (force ? hostProbes[id] !== 'skipped' : isStale(hostProbes[id], now)));
    if (todo.length === 0) return;

    set((s) => {
      const marked = { ...s.hostProbes };
      for (const id of todo) marked[id] = 'running';
      return { hostProbes: marked };
    });

    const write = (id: string, state: ProbeState) =>
      set((s) => ({ hostProbes: { ...s.hostProbes, [id]: state } }));

    // A few at a time: a page of hosts that are all down would otherwise
    // open one socket each and wait out the timeout together.
    const queue = [...todo];
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        const server = servers.find((s) => s.id === id);
        if (!server) continue;
        // Reached some other way than a TCP connection from here, so a TCP
        // connection from here says nothing about it.
        if (server.proxy_jump || server.proxy_command) { write(id, 'skipped'); continue; }
        try {
          const probe = await ipc.probeHost(
            server.host,
            server.port,
            server.connection_timeout ?? settings.connection_timeout_secs,
          );
          write(id, { ...probe, at: Date.now() } satisfies Probed);
        } catch (e) {
          write(id, { reachable: false, ms: 0, error: String(e), at: Date.now() });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, todo.length) }, worker));
  },
});
