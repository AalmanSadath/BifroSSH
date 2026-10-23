import { withConnectLog } from '../../connectLog';
import * as ipc from '../../ipc';
import { UNDETECTED_OS } from '../../types';
import type { AuthType, ContainerTab, JumpHopParams, SessionTab } from '../../types';
import { buildJumpChain, containerRequest, containerTabName, resolveServerAuth, type ContainersConn } from '../auth';
import { saveOpenTabs } from '../persistence';
import { isAndroid } from '../../platform';
import type { AppStore, Slice } from '../types';

/** Opening new tabs: on a saved host, a container, this machine, or a quick connection. */
export interface ConnectSlice {
  /** `title` is a name recorded for a restored tab; new tabs have none. */
  /** Opens a tab on a saved host; with `container`, into that container instead of the host's shell. */
  openSession: (serverId: string, title?: string, container?: ContainerTab) => Promise<void>;
  /** Opens a tab with a shell on this machine in it. */
  openLocalShell: () => Promise<void>;
  quickConnect: (host: string, port: number, username: string, authType: AuthType, authValue: string) => Promise<void>;
  /** The Containers panel's connection, kept here so switching panels does not drop it. */
  containersConn: ContainersConn | null;
  setContainersConn: (conn: ContainersConn | null) => void;
}

type Set = Parameters<Slice<ConnectSlice>>[0];

/**
 * Opens a session tab, runs a connect, and narrates it.
 *
 * The same steps were written three times, twice here and once in the SFTP
 * panel: listen on the log channel the id names, put a connecting tab on
 * screen, invoke, and turn the tab into a connected one or a failed one.
 * The listening is `withConnectLog`'s, which the panels share.
 *
 * Returns the backend's session id, or null if the connect failed; the tab has
 * already been told either way.
 */
async function startSession(
  set: Set,
  get: () => AppStore,
  connectId: string,
  tab: SessionTab,
  connect: () => Promise<string>,
): Promise<string | null> {
  try {
    const sessionId = await withConnectLog(
      connectId,
      (entry) => get().appendSessionLog(connectId, entry),
      () => {
        set((s) => {
          const sessions = [...s.sessions, tab];
          saveOpenTabs(sessions);
          return { sessions, activeTabId: connectId };
        });
        return connect();
      },
    );
    get().updateSessionConnected(connectId, sessionId);
    return sessionId;
  } catch (err) {
    get().updateSessionError(connectId, String(err));
    return null;
  }
}

export const createConnectSlice: Slice<ConnectSlice> = (set, get) => ({
  containersConn: null,
  setContainersConn: (conn) => set({ containersConn: conn }),

  openSession: async (serverId, title, container) => {
    const { servers, identities, sessions, detectServerOs } = get();
    const server = servers.find((s) => s.id === serverId);
    if (!server) return;

    // Resolve credentials: identity takes priority, then server-direct credentials
    const connectId = crypto.randomUUID();
    const existing = sessions.filter((s) => s.server_id === serverId && !s.container).length;
    const tabName = container
      ? containerTabName(container, server.name)
      : existing === 0 ? server.name : `${server.name} (${existing})`;

    const resolved = await resolveServerAuth(server, identities);
    if (!resolved) {
      // A host with nothing to authenticate with used to fail silently here:
      // the caller could pass a fallback, none ever did, and double-clicking
      // the card simply did nothing. It opens a failed tab instead, the same
      // as any other reason a connection could not be made.
      //
      // The reason is written as a log entry rather than only onto the tab,
      // because that transcript is where every other failure explains itself
      // and it is what Copy logs hands over.
      const reason =
        server.identity_id && !identities.some((i) => i.id === server.identity_id)
          ? `"${server.name}" uses an identity that no longer exists. Pick another one in its settings.`
          : `No authentication is configured for "${server.name}". Add a key, password or prompt auth in its settings.`;
      set((s) => ({
        sessions: [...s.sessions, {
          tab_id: connectId,
          session_id: null,
          server_name: tabName,
          title,
          server_id: serverId,
          container,
          status: 'error',
          error: reason,
          logs: [{ kind: 'error', message: reason }],
        }],
        activeTabId: connectId,
      }));
      get().recordError('connecting a tab', reason);
      return;
    }
    const { username, authType, authValue } = resolved;

    // Resolved before the tab exists, since a broken jump chain should reach
    // the session's own error view like any other failure to connect.
    let jumps: JumpHopParams[] = [];
    const ok = await startSession(
      set,
      get,
      connectId,
      {
        tab_id: connectId,
        session_id: null,
        server_name: tabName,
        title,
        server_id: serverId,
        container,
        status: 'connecting',
        connect_id: connectId,
        logs: [],
      },
      async () => {
        jumps = await buildJumpChain(server, servers, identities);
        return ipc.sshConnect({
          server_id: serverId,
          username,
          auth_type: authType,
          auth_value: authValue,
          cols: 80,
          rows: 24,
          connect_id: connectId,
          jumps,
          container: containerRequest(container),
        });
      },
    );

    if (ok && server.os === UNDETECTED_OS) detectServerOs(serverId, username, authType, authValue, jumps);
    // The backend opened the log before connecting; the tab only needs to know.
    if (ok && server.log_sessions) {
      set((s) => ({ sessions: s.sessions.map((t) => (t.tab_id === connectId ? { ...t, logging: 'host' } : t)) }));
    }
    // A container tab is a second view of a host already in use, not a
    // connection to it that tunnels should start with.
    if (ok && !container) get().autostartTunnels({ kind: 'connect', serverId });
    // To the top of the launcher icon's shortcuts.
    if (ok && isAndroid) ipc.androidHostUsed(serverId, server.name).catch(() => {});
  },

  openLocalShell: async () => {
    const connectId = crypto.randomUUID();
    await startSession(
      set,
      get,
      connectId,
      {
        tab_id: connectId,
        session_id: null,
        server_name: 'Local',
        server_id: '',
        kind: 'local',
        status: 'connecting',
        connect_id: connectId,
        logs: [],
      },
      () => ipc.localShellConnect(80, 24),
    );
  },

  quickConnect: async (host, port, username, authType, authValue) => {
    const connectId = crypto.randomUUID();
    await startSession(
      set,
      get,
      connectId,
      {
        tab_id: connectId,
        session_id: null,
        server_name: `${username}@${host}`,
        server_id: '',
        status: 'connecting',
        connect_id: connectId,
        logs: [],
        quick_info: { host, port, username },
      },
      () => ipc.sshConnectQuick({
        host, port, username,
        auth_type: authType,
        auth_value: authValue,
        cols: 80, rows: 24,
        connect_id: connectId,
        jumps: [],
      }),
    );
  },
});
