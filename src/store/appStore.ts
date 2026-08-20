import { create } from 'zustand';
import { listen } from '@tauri-apps/api/event';
import * as ipc from '../ipc';
import { STORED, UNDETECTED_OS, UNKNOWN_OS } from '../types';
import type { AuthType, Codeprint, GeneratedKey, Identity, IdentityInput, JumpHopParams, KeyContent, KeyEntry, LogEntry, PortForwarding, Server, ServerInput, SessionTab, Settings } from '../types';
import type { NamedTheme } from '../styles/themes';

// These three collections used to live here. They are now kept in the Rust
// store alongside servers and keys; the keys remain only so existing data can
// be migrated across once.
const CUSTOM_THEMES_KEY = 'bifrossh_custom_themes';
const CODEPRINTS_KEY = 'bifrossh_codeprints';
const PORT_FORWARDINGS_KEY = 'bifrossh_port_forwardings';

/**
 * Persists a collection to the backing store.
 *
 * Deliberately fire-and-forget: these are edited far more often than they fail
 * to save, and blocking the UI on a disk write would be worse than logging it.
 */
function persist(save: () => Promise<void>) {
  // Reported rather than only logged. The state has already been changed by
  // the time this runs, so a failure here means the screen and the disk have
  // parted company, which is exactly the thing worth saying out loud.
  save().catch(reportFailure);
}

function readLegacy<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Moves anything still in localStorage into the backing store, once.
 *
 * Only runs when the store side is empty, so it cannot overwrite newer data,
 * and the localStorage key is removed only after the save has succeeded, so a
 * failure here leaves the original data untouched to be retried next launch.
 */
async function migrateLegacyStorage(current: {
  portForwardings: PortForwarding[];
  codeprints: Codeprint[];
  customThemes: Record<string, NamedTheme>;
}): Promise<typeof current> {
  const result = { ...current };

  const legacyPfs = readLegacy<PortForwarding[]>(PORT_FORWARDINGS_KEY, []);
  if (legacyPfs.length > 0 && current.portForwardings.length === 0) {
    await ipc.savePortForwardings(legacyPfs);
    result.portForwardings = legacyPfs;
  }
  if (legacyPfs.length === 0 || result.portForwardings === legacyPfs) {
    localStorage.removeItem(PORT_FORWARDINGS_KEY);
  }

  const legacyCps = readLegacy<Codeprint[]>(CODEPRINTS_KEY, []);
  if (legacyCps.length > 0 && current.codeprints.length === 0) {
    await ipc.saveCodeprints(legacyCps);
    result.codeprints = legacyCps;
  }
  if (legacyCps.length === 0 || result.codeprints === legacyCps) {
    localStorage.removeItem(CODEPRINTS_KEY);
  }

  const legacyThemes = readLegacy<Record<string, NamedTheme>>(CUSTOM_THEMES_KEY, {});
  if (Object.keys(legacyThemes).length > 0 && Object.keys(current.customThemes).length === 0) {
    await ipc.saveCustomThemes(legacyThemes);
    result.customThemes = legacyThemes;
  }
  if (Object.keys(legacyThemes).length === 0 || result.customThemes === legacyThemes) {
    localStorage.removeItem(CUSTOM_THEMES_KEY);
  }

  return result;
}

/**
 * The chosen app theme, mirrored outside the encrypted store.
 *
 * Settings live in data.json, which cannot be read until the master key is
 * available, so with a passphrase set the unlock screen would render before
 * its own theme was knowable and always came up dark. The theme is not a
 * secret, and this is only a cache: data.json stays authoritative, and the
 * worst a stale or missing value can do is show one screen in the wrong
 * colours before the real settings load over it.
 */
const APP_THEME_CACHE = 'bifrossh_app_theme';

function cachedAppTheme(): Settings['app_theme'] {
  const saved = localStorage.getItem(APP_THEME_CACHE);
  return saved === 'light' || saved === 'amoled' || saved === 'dark' ? saved : 'dark';
}

function cacheAppTheme(theme: Settings['app_theme']) {
  try {
    localStorage.setItem(APP_THEME_CACHE, theme);
  } catch {
    // Storage can be unavailable or full. Nothing here is worth failing over.
  }
}

const DEFAULT_SETTINGS: Settings = {
  theme: 'bifrossh-dark',
  font_size: 14,
  font_family: 'monospace',
  cursor_style: 'block',
  cursor_blink: true,
  app_theme: cachedAppTheme(),
  connection_timeout_secs: 60,
  show_hover_hints: true,
  sftp_inactivity_timeout_secs: 300,
  host_key_policy: 'ask',
  keepalive_interval_secs: 30,
};

interface AppStore {
  servers: Server[];
  identities: Identity[];
  keys: KeyEntry[];
  settings: Settings;
  sessions: SessionTab[];
  activeTabId: string | null;

  /** Set when `loadAll` could not read the saved data; see there. */
  loadError: string | null;
  loadAll: () => Promise<void>;

  /** The last action that failed with nobody to tell; see `reportFailure`. */
  actionError: string | null;
  setActionError: (message: string | null) => void;

  saveServer: (server: ServerInput, password?: string) => Promise<void>;
  deleteServer: (id: string) => Promise<void>;
  detectServerOs: (serverId: string, username: string, authType: AuthType, authValue: string, jumps?: JumpHopParams[]) => Promise<void>;

  importKey: (name: string, path: string, passphrase: string | null, storeContent: boolean) => Promise<void>;
  saveKeyFromContent: (name: string, content: string, passphrase: string | null) => Promise<void>;
  generateKey: (algorithm: string, passphrase?: string | null) => Promise<GeneratedKey>;
  getKeyContent: (keyId: string) => Promise<KeyContent>;
  updateKey: (keyId: string, name: string, content: string, passphrase: string | null) => Promise<void>;
  deleteKey: (id: string) => Promise<void>;

  saveIdentity: (identity: IdentityInput, password?: string) => Promise<void>;
  deleteIdentity: (id: string) => Promise<void>;

  saveSettings: (settings: Settings) => Promise<void>;

  customThemes: Record<string, NamedTheme>;
  saveCustomTheme: (id: string, theme: NamedTheme) => void;
  deleteCustomTheme: (id: string) => void;

  portForwardings: PortForwarding[];
  savePortForwarding: (pf: Omit<PortForwarding, 'id'> & { id?: string }) => void;
  deletePortForwarding: (id: string) => void;
  activeTunnelIds: Set<string>;
  startTunnel: (pf: PortForwarding) => Promise<void>;
  stopTunnel: (pfId: string) => Promise<void>;

  codeprints: Codeprint[];
  addCodeprint: (cp: Omit<Codeprint, 'id'>) => void;
  updateCodeprint: (id: string, cp: Omit<Codeprint, 'id'>) => void;
  deleteCodeprint: (id: string) => void;

  sessionThemeOverrides: Record<string, string>;
  setSessionTheme: (sessionId: string, themeKey: string) => void;

  addSession: (tab: SessionTab) => void;
  removeSession: (sessionId: string) => void;
  renameSession: (sessionId: string, name: string) => void;
  updateSessionConnected: (connectId: string, sessionId: string) => void;
  updateSessionError: (connectId: string, error: string) => void;
  appendSessionLog: (connectId: string, entry: LogEntry) => void;
  openSession: (serverId: string) => Promise<void>;
  quickConnect: (host: string, port: number, username: string, authType: AuthType, authValue: string) => Promise<void>;
  setActiveTab: (id: string | null) => void;
}

/** How a server's credentials resolve for a connect. */
export interface ResolvedAuth {
  username: string;
  authType: AuthType;
  authValue: string;
}

/**
 * Single source of truth for turning a server (and its identity, if any) into
 * connect credentials. Terminal sessions, SFTP and tunnels all go through this
 * so a new auth mode does not have to be taught to each of them separately.
 *
 * Returns null when nothing usable is configured.
 */
export async function resolveServerAuth(
  server: Server,
  identities: Identity[],
): Promise<ResolvedAuth | null> {
  if (server.identity_id) {
    const identity = identities.find((i) => i.id === server.identity_id);
    if (!identity) return null;
    if (identity.auth_kind === 'keyboard-interactive') {
      // Nothing stored: the server asks and the user answers at connect time.
      return { username: identity.username, authType: 'keyboard-interactive', authValue: '' };
    }
    if (identity.auth_kind === 'agent') {
      // The agent holds the key; authValue optionally pins one by fingerprint.
      return {
        username: identity.username,
        authType: 'agent',
        authValue: identity.agent_fingerprint ?? '',
      };
    }
    if (identity.encrypted_password === STORED) {
      return {
        username: identity.username,
        authType: 'password',
        authValue: await ipc.getIdentityPassword(identity.id),
      };
    }
    if (identity.key_id) {
      return { username: identity.username, authType: 'key', authValue: identity.key_id };
    }
    return null;
  }

  if (!server.username) return null;

  if (server.auth_kind === 'keyboard-interactive') {
    return { username: server.username, authType: 'keyboard-interactive', authValue: '' };
  }
  if (server.auth_kind === 'agent') {
    return { username: server.username, authType: 'agent', authValue: '' };
  }
  if (server.key_id) {
    return { username: server.username, authType: 'key', authValue: server.key_id };
  }
  if (server.encrypted_password === STORED) {
    return {
      username: server.username,
      authType: 'password',
      authValue: await ipc.getServerPassword(server.id),
    };
  }
  return null;
}

/**
 * Matches MAX_HOPS in src-tauri/src/jump.rs. Checked here as well so a loop is
 * caught before any connection is attempted, and named in a message that says
 * which hosts are involved.
 */
const MAX_JUMP_HOPS = 8;

/**
 * Walks a server's chain of jump hosts and resolves each one's credentials.
 *
 * Returns the hops in the order they are connected in: the first is reached
 * over TCP, and each later one through the hop before it. `proxy_jump` points
 * from a server to the host it is reached *through*, so the chain is walked
 * inwards and then reversed.
 *
 * A jump host that has no usable credentials is an error rather than a silent
 * direct connection, which would bypass the bastion the user asked for.
 */
export async function buildJumpChain(
  server: Server,
  servers: Server[],
  identities: Identity[],
): Promise<JumpHopParams[]> {
  const hops: JumpHopParams[] = [];
  const seen = new Set<string>([server.id]);

  let current = server;
  while (current.proxy_jump) {
    const jump = servers.find((s) => s.id === current.proxy_jump);
    if (!jump) {
      throw new Error(`The jump host configured for "${current.name}" no longer exists`);
    }
    if (seen.has(jump.id)) {
      throw new Error(`"${jump.name}" is part of a loop of jump hosts`);
    }
    if (hops.length >= MAX_JUMP_HOPS) {
      throw new Error(`More than ${MAX_JUMP_HOPS} jump hosts chained from "${server.name}"`);
    }
    seen.add(jump.id);

    const resolved = await resolveServerAuth(jump, identities);
    if (!resolved) {
      throw new Error(`No credentials configured for the jump host "${jump.name}"`);
    }
    hops.push({
      host: jump.host,
      port: jump.port,
      username: resolved.username,
      auth_type: resolved.authType,
      auth_value: resolved.authValue,
    });
    current = jump;
  }

  return hops.reverse();
}

export const useAppStore = create<AppStore>((set, get) => ({
  servers: [],
  identities: [],
  customThemes: {},
  portForwardings: [],
  activeTunnelIds: new Set<string>(),
  codeprints: [],
  sessionThemeOverrides: {},
  keys: [],
  settings: DEFAULT_SETTINGS,
  sessions: [],
  activeTabId: 'hosts',

  loadError: null,
  actionError: null,
  setActionError: (message) => set({ actionError: message }),

  // Seven reads, and every way they could fail used to escape as an unhandled
  // rejection: Promise.all rejects on the first one, so a single command
  // failing left every panel showing its empty default with nothing said. That
  // reads as a vault which opened onto no data rather than a read that did not
  // finish.
  //
  // Nothing is at risk from it. Saves go through the backend's own copy of the
  // document, so the empty lists here cannot be written over the full ones
  // there. What was missing is the user being told the screen is not the
  // truth, and being able to ask again.
  loadAll: async () => {
    try {
      const [servers, identities, keys, settings, portForwardings, codeprints, customThemes] =
        await Promise.all([
          ipc.listServers(),
          ipc.listIdentities(),
          ipc.listKeys(),
          ipc.getSettings(),
          ipc.getPortForwardings(),
          ipc.getCodeprints(),
          ipc.getCustomThemes(),
        ]);

      cacheAppTheme(settings.app_theme);

      let collections = { portForwardings, codeprints, customThemes };
      try {
        collections = await migrateLegacyStorage(collections);
      } catch (e) {
        // Leave localStorage intact so the next launch can retry rather than
        // losing the user's rules.
        console.error('Could not migrate saved data out of localStorage', e);
      }

      set({ servers, identities, keys, settings, ...collections, loadError: null });
    } catch (e) {
      console.error('Could not load saved data', e);
      set({ loadError: String(e) });
    }
  },

  saveServer: async (server, password) => {
    const saved = await ipc.saveServer({ id: server.id ?? '', ...server }, password ?? null);
    set((s) => {
      const exists = s.servers.some((x) => x.id === saved.id);
      return {
        servers: exists
          ? s.servers.map((x) => (x.id === saved.id ? saved : x))
          : [...s.servers, saved],
      };
    });
  },

  deleteServer: async (id) => {
    await ipc.deleteServer(id);
    set((s) => ({ servers: s.servers.filter((x) => x.id !== id) }));
  },

  detectServerOs: async (serverId, username, authType, authValue, jumps) => {
    try {
      const detectedOs = await ipc.detectServerOs(serverId, username, authType, authValue, jumps ?? []);
      set((s) => ({
        servers: s.servers.map((srv) =>
          srv.id === serverId ? { ...srv, os: detectedOs } : srv
        ),
      }));
    } catch (e) {
      console.warn('[OS detect]', e);
      // Matches what the backend has now recorded for this host, so the two
      // agree and the next launch does not start over.
      set((s) => ({
        servers: s.servers.map((srv) =>
          srv.id === serverId ? { ...srv, os: UNKNOWN_OS } : srv
        ),
      }));
    }
  },

  importKey: async (name, path, passphrase, storeContent) => {
    const key = await ipc.importKeyFromPath(name, path, passphrase, storeContent);
    set((s) => ({ keys: [...s.keys, key] }));
  },

  saveKeyFromContent: async (name, content, passphrase) => {
    const key = await ipc.saveKeyFromContent(name, content, passphrase);
    set((s) => ({ keys: [...s.keys, key] }));
  },

  generateKey: async (algorithm, passphrase) => {
    return ipc.generateKey(algorithm, passphrase ?? null);
  },

  getKeyContent: async (keyId) => {
    return ipc.getKeyContent(keyId);
  },

  updateKey: async (keyId, name, content, passphrase) => {
    await ipc.updateKey(keyId, name, content, passphrase);
    const keys = await ipc.listKeys();
    set({ keys });
  },

  deleteKey: async (id) => {
    await ipc.deleteKey(id);
    set((s) => ({
      keys: s.keys.filter((k) => k.id !== id),
    }));
  },

  saveIdentity: async (identity, password?) => {
    const saved = await ipc.saveIdentity({ id: identity.id ?? '', ...identity }, password ?? null);
    set((s) => {
      const exists = s.identities.some((x) => x.id === saved.id);
      return {
        identities: exists
          ? s.identities.map((x) => (x.id === saved.id ? saved : x))
          : [...s.identities, saved],
      };
    });
  },

  deleteIdentity: async (id) => {
    await ipc.deleteIdentity(id);
    set((s) => ({
      identities: s.identities.filter((x) => x.id !== id),
      servers: s.servers.map((srv) =>
        srv.identity_id === id ? { ...srv, identity_id: null } : srv
      ),
    }));
  },

  saveSettings: async (settings) => {
    await ipc.saveSettings(settings);
    cacheAppTheme(settings.app_theme);
    set({ settings });
  },

  saveCustomTheme: (id, theme) => {
    set((s) => {
      const next = { ...s.customThemes, [id]: theme };
      persist(() => ipc.saveCustomThemes(next));
      return { customThemes: next };
    });
  },

  deleteCustomTheme: (id) => {
    set((s) => {
      const next = { ...s.customThemes };
      delete next[id];
      persist(() => ipc.saveCustomThemes(next));
      return { customThemes: next };
    });
  },

  savePortForwarding: (pf) => {
    set((s) => {
      const id = pf.id ?? crypto.randomUUID();
      const entry: PortForwarding = { ...pf, id };
      const exists = s.portForwardings.some((x) => x.id === id);
      const next = exists
        ? s.portForwardings.map((x) => (x.id === id ? entry : x))
        : [...s.portForwardings, entry];
      persist(() => ipc.savePortForwardings(next));
      return { portForwardings: next };
    });
  },

  deletePortForwarding: (id) => {
    set((s) => {
      const next = s.portForwardings.filter((x) => x.id !== id);
      persist(() => ipc.savePortForwardings(next));
      return { portForwardings: next };
    });
  },

  startTunnel: async (pf) => {
    const { servers, identities } = get();
    const serverId = pf.type === 'remote' ? pf.remote_host_id : pf.intermediate_host_id;
    if (!serverId) throw new Error('No server configured for this rule');
    const server = servers.find((s) => s.id === serverId);
    if (!server) throw new Error('Server not found');

    let username: string;
    let authType: AuthType;
    let authValue: string;

    const resolved = await resolveServerAuth(server, identities);
    if (!resolved) throw new Error('No credentials configured for this server');
    ({ username, authType, authValue } = resolved);

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

  stopTunnel: async (pfId) => {
    await ipc.tunnelStop(pfId);
    set((s) => { const n = new Set(s.activeTunnelIds); n.delete(pfId); return { activeTunnelIds: n }; });
  },

  addCodeprint: (cp) => {
    set((s) => {
      const next = [...s.codeprints, { id: crypto.randomUUID(), ...cp }];
      persist(() => ipc.saveCodeprints(next));
      return { codeprints: next };
    });
  },

  updateCodeprint: (id, cp) => {
    set((s) => {
      const next = s.codeprints.map((c) => c.id === id ? { ...c, ...cp } : c);
      persist(() => ipc.saveCodeprints(next));
      return { codeprints: next };
    });
  },

  deleteCodeprint: (id) => {
    set((s) => {
      const next = s.codeprints.filter((c) => c.id !== id);
      persist(() => ipc.saveCodeprints(next));
      return { codeprints: next };
    });
  },

  setSessionTheme: (sessionId, themeKey) => {
    set((s) => ({
      sessionThemeOverrides: { ...s.sessionThemeOverrides, [sessionId]: themeKey },
    }));
  },

  addSession: (tab) =>
    set((s) => ({
      sessions: [...s.sessions, tab],
      activeTabId: tab.session_id,
    })),

  removeSession: (sessionId) =>
    set((s) => {
      const next = s.sessions.filter((x) => x.session_id !== sessionId);
      const nextActive =
        s.activeTabId === sessionId
          ? next.length > 0
            ? next[next.length - 1].session_id
            : 'hosts'
          : s.activeTabId;
      // The override is keyed on a session id that will never be reused, so
      // leaving it behind grows the map for the life of the process.
      const { [sessionId]: _dropped, ...themeOverrides } = s.sessionThemeOverrides;
      return { sessions: next, activeTabId: nextActive, sessionThemeOverrides: themeOverrides };
    }),

  renameSession: (sessionId, name) =>
    set((s) => ({
      sessions: s.sessions.map((t) =>
        t.session_id === sessionId ? { ...t, server_name: name } : t
      ),
    })),

  updateSessionConnected: (connectId, sessionId) =>
    set((s) => ({
      sessions: s.sessions.map((t) =>
        t.session_id === connectId
          ? { ...t, session_id: sessionId, status: 'connected', connect_id: undefined, error: undefined }
          : t
      ),
      activeTabId: s.activeTabId === connectId ? sessionId : s.activeTabId,
    })),

  updateSessionError: (connectId, error) =>
    set((s) => ({
      sessions: s.sessions.map((t) =>
        t.session_id === connectId ? { ...t, status: 'error', error } : t
      ),
    })),

  appendSessionLog: (connectId, entry) =>
    set((s) => ({
      sessions: s.sessions.map((t) =>
        t.session_id === connectId
          ? { ...t, logs: [...(t.logs ?? []), entry] }
          : t
      ),
    })),

  openSession: async (serverId) => {
    const { servers, identities, sessions, detectServerOs } = get();
    const server = servers.find((s) => s.id === serverId);
    if (!server) return;

    // Resolve credentials: identity takes priority, then server-direct credentials
    let username: string;
    let authType: AuthType;
    let authValue: string;

    const connectId = crypto.randomUUID();
    const existing = sessions.filter((s) => s.server_id === serverId).length;
    const tabName = existing === 0 ? server.name : `${server.name} (${existing})`;

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
          session_id: connectId,
          server_name: tabName,
          server_id: serverId,
          status: 'error',
          error: reason,
          logs: [{ kind: 'error', message: reason }],
        }],
        activeTabId: connectId,
      }));
      return;
    }
    ({ username, authType, authValue } = resolved);

    // Resolved before the tab exists, since a broken jump chain should reach
    // the session's own error view like any other failure to connect.
    let jumps: JumpHopParams[] = [];
    const ok = await startSession(
      connectId,
      {
        session_id: connectId,
        server_name: tabName,
        server_id: serverId,
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
        });
      },
    );

    if (ok && server.os === UNDETECTED_OS) detectServerOs(serverId, username, authType, authValue, jumps);
  },

  quickConnect: async (host, port, username, authType, authValue) => {
    const connectId = crypto.randomUUID();
    await startSession(
      connectId,
      {
        session_id: connectId,
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

  setActiveTab: (id) => set({ activeTabId: id }),
}));

/**
 * Catch handler for an action whose caller has nowhere to put an error.
 *
 * A delete fired from a confirm modal, or a setting toggled from a row, has no
 * error slot of its own; every one of them was called without `await` and
 * without `.catch`, so the modal closed and the failure went nowhere. The
 * lists stayed honest, because the store only patches state after the await
 * resolves, but nothing said the thing had not happened.
 */
export function reportFailure(e: unknown) {
  console.error(e);
  useAppStore.getState().setActionError(String(e));
}

/**
 * Opens a session tab, runs a connect, and narrates it.
 *
 * The same six steps were written three times, twice here and once in the
 * SFTP panel: mint an id, listen on the log channel it names, put a
 * connecting tab on screen, invoke, stop listening a moment later, and turn
 * the tab into a connected one or a failed one.
 *
 * The delay before unlistening is the part worth keeping in one place. The
 * backend emits its last log lines just before the command returns, and those
 * race the response over the same bridge, so unlistening on the response
 * itself loses the end of the transcript.
 *
 * Returns the backend's session id, or null if the connect failed; the tab has
 * already been told either way.
 */
async function startSession(
  connectId: string,
  tab: SessionTab,
  connect: () => Promise<string>,
): Promise<string | null> {
  const unlisten = await listen<LogEntry>(`ssh-connect-log:${connectId}`, (event) => {
    useAppStore.getState().appendSessionLog(connectId, event.payload);
  });

  useAppStore.setState((s) => ({
    sessions: [...s.sessions, tab],
    activeTabId: connectId,
  }));

  try {
    const sessionId = await connect();
    setTimeout(unlisten, 1000);
    useAppStore.getState().updateSessionConnected(connectId, sessionId);
    return sessionId;
  } catch (err) {
    unlisten();
    useAppStore.getState().updateSessionError(connectId, String(err));
    return null;
  }
}

