import * as ipc from '../../ipc';
import { buildJumpChain, containerRequest, resolveServerAuth } from '../auth';
import { RETRY_FIRST_MS, RETRY_MAX_MS } from '../defaults';
import { startOrStopRecording } from '../recording';
import type { Slice } from '../types';

/** What happens to a tab whose connection went away. */
export interface ReconnectSlice {
  /**
   * The tab's session went away. `endedWith` is set when it was the command
   * that failed rather than the connection, which is never retried on its own.
   */
  markDropped: (tabId: string, endedWith?: number) => void;
  /** Connects a dropped tab again, into the same terminal. */
  reconnectSession: (tabId: string) => Promise<void>;
  /** Tabs being brought back on their own, with backoff. */
  retryingTabIds: Set<string>;
  /** Stops the loop for one tab and clears its countdown. */
  stopRetrying: (tabId: string) => void;
  /**
   * One attempt after `delayMs`, then the next at twice the wait, up to a
   * minute, until the session is back, the user stops it, the tab goes, or
   * the attempt limit in Settings is reached. Not called directly: a drop
   * starts it.
   */
  retryLoop: (tabId: string, delayMs: number, attempt: number) => Promise<void>;
  /**
   * Tries every retrying tab at once instead of when its countdown runs
   * out, for when the network has just come back or changed. The attempt
   * count carries on; the wait after it starts again from 5s.
   */
  retryTabsNow: () => void;
}

/**
 * Which retry loop is current for each tab. Every pass of a loop notes the
 * number when it starts waiting; trying at once moves it on, so the pass
 * that was waiting stops when it wakes instead of trying a second time.
 */
const tabRetryGen = new Map<string, number>();

export const createReconnectSlice: Slice<ReconnectSlice> = (set, get) => ({
  markDropped: (tabId, endedWith) => {
    set((s) => {
      // Whatever was running went with the connection, and its shell will
      // never send the mark that rounds it off.
      const { [tabId]: _activity, ...activity } = s.sessionActivity;
      return {
        sessions: s.sessions.map((t) =>
          t.tab_id === tabId ? { ...t, status: 'dropped', session_id: null, error: undefined, ended_with: endedWith } : t
        ),
        sessionActivity: activity,
      };
    });

    const { settings, sessions } = get();
    const tab = sessions.find((t) => t.tab_id === tabId);
    // A quick connection has no saved host to connect to again.
    if (endedWith !== undefined || !settings.auto_reconnect || !tab || tab.quick_info) return;
    set((s) => ({ retryingTabIds: new Set(s.retryingTabIds).add(tabId) }));
    get().retryLoop(tabId, RETRY_FIRST_MS, 1);
  },

  retryingTabIds: new Set<string>(),

  stopRetrying: (tabId) => {
    set((s) => {
      const next = new Set(s.retryingTabIds);
      next.delete(tabId);
      return {
        retryingTabIds: next,
        sessions: s.sessions.map((t) => (t.tab_id === tabId ? { ...t, retryAt: undefined } : t)),
      };
    });
  },

  retryLoop: async (tabId, delayMs, attempt) => {
    const gen = tabRetryGen.get(tabId) ?? 0;
    // The countdown the banner shows is this, rather than a timer the
    // component keeps: one clock, and it survives a re-render.
    set((s) => ({
      sessions: s.sessions.map((t) => (t.tab_id === tabId ? { ...t, retryAt: Date.now() + delayMs, retryAttempt: attempt } : t)),
    }));
    await new Promise((r) => setTimeout(r, delayMs));
    if ((tabRetryGen.get(tabId) ?? 0) !== gen) return;

    // Stopped, closed, or brought back by hand while we waited.
    const { retryingTabIds, sessions, settings } = get();
    const tab = sessions.find((t) => t.tab_id === tabId);
    if (!retryingTabIds.has(tabId) || !tab || tab.status !== 'dropped') {
      get().stopRetrying(tabId);
      return;
    }

    await get().reconnectSession(tabId);
    const after = get().sessions.find((t) => t.tab_id === tabId);
    if (!after || after.status === 'connected') {
      get().stopRetrying(tabId);
      return;
    }
    // Still dropped. A limit of 0 means keep going.
    const limit = settings.auto_reconnect_attempts;
    if (limit > 0 && attempt >= limit) {
      set((s) => ({
        sessions: s.sessions.map((t) => (t.tab_id === tabId ? { ...t, gaveUpAfter: attempt } : t)),
      }));
      get().stopRetrying(tabId);
      return;
    }
    if (!get().retryingTabIds.has(tabId)) return;
    void get().retryLoop(tabId, Math.min(Math.max(delayMs * 2, RETRY_FIRST_MS), RETRY_MAX_MS), attempt + 1);
  },

  retryTabsNow: () => {
    const { retryingTabIds, sessions } = get();
    for (const tabId of retryingTabIds) {
      const tab = sessions.find((t) => t.tab_id === tabId);
      // One already reconnecting is in the middle of the try this would make.
      if (!tab || tab.reconnecting) continue;
      tabRetryGen.set(tabId, (tabRetryGen.get(tabId) ?? 0) + 1);
      void get().retryLoop(tabId, 0, tab.retryAttempt ?? 1);
    }
  },

  reconnectSession: async (tabId) => {
    const { sessions, servers, identities } = get();
    const tab = sessions.find((t) => t.tab_id === tabId);
    if (!tab || tab.status !== 'dropped' || tab.reconnecting) return;
    const server = servers.find((sv) => sv.id === tab.server_id);
    if (!server) return;

    // Resolved again rather than remembered: the host may have been edited
    // since, and the credentials are whatever it says now.
    const resolved = await resolveServerAuth(server, identities);
    if (!resolved) {
      get().setActionError(`No authentication is configured for "${server.name}".`);
      return;
    }

    set((s) => ({
      sessions: s.sessions.map((t) => (
        t.tab_id === tabId ? { ...t, reconnecting: true, error: undefined, retryAt: undefined, gaveUpAfter: undefined, ended_with: undefined } : t
      )),
    }));
    try {
      const jumps = await buildJumpChain(server, servers, identities);
      const sessionId = await ipc.sshConnect({
        server_id: server.id,
        username: resolved.username,
        auth_type: resolved.authType,
        auth_value: resolved.authValue,
        cols: 80,
        rows: 24,
        connect_id: crypto.randomUUID(),
        jumps,
        container: containerRequest(tab.container),
      });
      get().updateSessionConnected(tabId, sessionId);
      // A logged tab goes on being logged, to a new file for the new session.
      // A host-logged tab was reopened logging by the backend; a tab-logged
      // one is asked for again, to a new file for the new session.
      if (tab.logging === 'tab') {
        const ok = await ipc.sshSetLog(sessionId, tab.server_name, true).then(() => true, () => false);
        set((s) => ({ sessions: s.sessions.map((t) => (t.tab_id === tabId ? { ...t, logging: ok ? 'tab' : undefined } : t)) }));
      }
      // Likewise a recording: the old file ended with the old session.
      if (tab.recording) {
        const path = await startOrStopRecording(sessionId, tabId, tab.server_name, true).catch(() => null);
        set((s) => ({ sessions: s.sessions.map((t) => (t.tab_id === tabId ? { ...t, recording: path ?? undefined } : t)) }));
      }
    } catch (err) {
      // Still dropped, still there. The banner shows why it did not come back.
      set((s) => ({
        sessions: s.sessions.map((t) =>
          t.tab_id === tabId ? { ...t, reconnecting: false, error: String(err) } : t
        ),
      }));
    }
  },
});
