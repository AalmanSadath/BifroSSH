import { create } from 'zustand';
import { listen } from '@tauri-apps/api/event';
import * as ipc from '../ipc';
import { getVersion } from '@tauri-apps/api/app';
import { CHECK_INTERVAL_SECS, fetchLatestRelease, newerVersion, type Release } from '../updates';
import { STORED, UNDETECTED_OS, UNKNOWN_OS } from '../types';
import { restoreOrder, tabsToSave } from '../sessionRestore';
import type { AuthType, Codeprint, SftpBookmark, GeneratedKey, Identity, IdentityInput, JumpHopParams, KeyContent, KeyEntry, LogEntry, PortForwarding, ResolvedTheme, Server, ServerInput, SessionTab, Settings, SettingsSection, SystemAppearance } from '../types';
import type { NamedTheme } from '../styles/themes';

/**
 * The sessions that input from `tabId` reaches: its own, and when it is
 * marked for broadcast, every other marked tab that has a live session. A
 * tab with no session (connecting, dropped) sends nowhere, and a marked tab
 * that is dropped is left out rather than failing the others.
 */
export function broadcastTargets(sessions: SessionTab[], tabId: string): string[] {
  const from = sessions.find((t) => t.tab_id === tabId);
  if (!from) return [];
  if (!from.broadcast) return from.session_id ? [from.session_id] : [];
  return sessions
    .filter((t) => t.broadcast && t.session_id && t.status === 'connected')
    .map((t) => t.session_id as string);
}

/** Panes side by side before the terminals stop being useful. */
const MAX_SPLIT = 4;

/** The group without `tabId`; a group of one is no group. */
export function pruneSplit(group: string[], tabId: string): string[] {
  const rest = group.filter((id) => id !== tabId);
  return rest.length > 1 ? rest : [];
}

/** What just happened, for the tunnels that start on their own. */
export type AutostartTrigger = { kind: 'launch' } | { kind: 'connect'; serverId: string };

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

/**
 * Writes down which hosts have a tab open, so the next launch can put them
 * back. Called after every change to the strip rather than at shutdown:
 * the window can close without the app being asked first.
 */
function saveOpenTabs(sessions: SessionTab[]) {
  ipc.saveOpenTabs(tabsToSave(sessions)).catch(() => {
    // Not worth a banner. Worst case a restart opens the previous strip.
  });
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

export function cachedAppTheme(): ResolvedTheme {
  const saved = localStorage.getItem(APP_THEME_CACHE);
  return saved === 'light' || saved === 'amoled' || saved === 'dark' ? saved : 'dark';
}

/**
 * Caches the palette actually painted, not the setting.
 *
 * The setting can now be "system", which tells the next first paint nothing:
 * it would have to ask the desktop before it knew what to draw, and the point
 * of this cache is to draw something right before anything has been asked.
 */
function cacheAppTheme(theme: ResolvedTheme) {
  try {
    localStorage.setItem(APP_THEME_CACHE, theme);
  } catch {
    // Storage can be unavailable or full. Nothing here is worth failing over.
  }
}

/**
 * How long a retry waits, and how long it may grow to. Shared by the
 * tunnel retry and the terminal one, which are the same idea twice: come
 * back quickly at first, then stop hammering something that is down.
 */
const RETRY_FIRST_MS = 5_000;
const RETRY_MAX_MS = 60_000;

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
  auto_lock_minutes: 0,
  lock_on_suspend: true,
  scrollback_lines: 10000,
  session_log_dir: null,
  check_for_updates: true,
  last_update_check: 0,
  auto_reconnect: true,
  auto_reconnect_attempts: 5,
  restore_tabs: true,
  shortcuts: {},
  accent_color: null,
};

/**
 * What the desktop last told us about itself.
 *
 * Read once at startup and again whenever the portal says it changed, so a
 * theme set to "system" follows the desktop live rather than only at launch.
 */
const NO_APPEARANCE: SystemAppearance = { color_scheme: 'no-preference', accent: null };

/**
 * The palette to paint, given the setting and what the desktop reports.
 *
 * Only an explicit "dark" means dark. "No preference" resolves to light, which
 * looks like the wrong way round until you watch what desktops actually send:
 * GNOME's Appearance panel offers Default and Dark, and choosing the light one
 * sets color-scheme to `default`, which the portal reports as 0, no
 * preference. It never sends 2. Treating 0 as dark meant switching the desktop
 * to light did nothing at all.
 *
 * It is also what CSS does. `prefers-color-scheme` dropped its no-preference
 * value, and user agents report light when nothing has been asked for.
 */
export function resolveAppTheme(
  setting: Settings['app_theme'],
  system: SystemAppearance,
): ResolvedTheme {
  if (setting !== 'system') return setting;
  return system.color_scheme === 'dark' ? 'dark' : 'light';
}

/**
 * The accent to paint: the user's choice, else the desktop's, else none, which
 * leaves each palette's own built-in accent in place.
 */
export function resolveAccent(
  settings: Pick<Settings, 'accent_color'>,
  system: SystemAppearance,
): string | null {
  return settings.accent_color ?? system.accent;
}

interface AppStore {
  servers: Server[];
  identities: Identity[];
  keys: KeyEntry[];
  settings: Settings;
  sessions: SessionTab[];
  activeTabId: string | null;
  /**
   * Tabs shown side by side, in strip order; empty when nothing is split.
   * The view is split whenever the active tab is one of them, and the
   * active tab is the focused pane. A tab outside the group shows alone
   * and leaves the group be, so coming back restores the split.
   */
  splitGroup: string[];
  /** Puts `dropped` beside `anchor`, starting a group from the anchor if there is none. */
  splitWith: (anchorTabId: string, droppedTabId: string) => void;
  unsplit: (tabId: string) => void;

  /** What the desktop reports about its own theme and accent. */
  systemAppearance: SystemAppearance;
  setSystemAppearance: (appearance: SystemAppearance) => void;

  /**
   * Which category the settings panel is showing. In the store rather than
   * in the panel so the palette and the panel's own links can open one.
   */
  settingsSection: SettingsSection;
  /** Shows the settings panel, on the category asked for. */
  openSettings: (section?: SettingsSection) => void;

  /** Set when `loadAll` could not read the saved data; see there. */
  loadError: string | null;
  loadAll: () => Promise<void>;

  /**
   * Opens the tabs that were open when the app last ran, one at a time.
   * Off when the setting says so, and a no-op once anything is open.
   */
  restoreTabs: () => Promise<void>;

  /**
   * A place the SFTP panel has been asked to show: set by a click on a
   * path in a terminal, cleared by the panel once it is there. The nonce
   * makes two clicks on the same path two requests.
   */
  sftpRequest: { serverId: string; path: string; nonce: number } | null;
  openInSftp: (serverId: string, path: string) => void;
  clearSftpRequest: () => void;

  /** A release newer than this build, once a check has found one. */
  updateAvailable: Release | null;
  /**
   * Asks GitHub for the latest release. Once a day and only when the
   * setting allows, unless forced from the Settings page. Resolves to
   * whether the check ran; never throws.
   */
  checkForUpdates: (force?: boolean) => Promise<boolean>;
  /**
   * What a lock does to this side. The backend has dropped its data; this
   * drops the copies. Settings stay, because the unlock screen is drawn from
   * them, and sessions stay, because their shells are still running behind
   * the lock and come back with it.
   */
  clearForLock: () => void;

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

  codeprints: Codeprint[];
  /** Directories saved for one click in the SFTP panel. */
  sftpBookmarks: SftpBookmark[];
  addBookmark: (bookmark: Omit<SftpBookmark, 'id'>) => void;
  deleteBookmark: (id: string) => void;

  addCodeprint: (cp: Omit<Codeprint, 'id'>) => void;
  updateCodeprint: (id: string, cp: Omit<Codeprint, 'id'>) => void;
  deleteCodeprint: (id: string) => void;

  /** Keyed by tab id. */
  sessionThemeOverrides: Record<string, string>;
  setSessionTheme: (tabId: string, themeKey: string) => void;

  addSession: (tab: SessionTab) => void;
  removeSession: (tabId: string) => void;
  renameSession: (tabId: string, name: string) => void;
  updateSessionConnected: (tabId: string, sessionId: string) => void;
  updateSessionError: (tabId: string, error: string) => void;
  appendSessionLog: (tabId: string, entry: LogEntry) => void;
  /** The connection under a tab went away; the tab stays. */
  markDropped: (tabId: string) => void;
  toggleBroadcast: (tabId: string) => void;
  /** Starts or stops writing the tab's output to a file; the banner says if it could not. */
  toggleLogging: (tabId: string) => Promise<void>;
  /**
   * Input from `tabId` to its own session, and when the tab broadcasts, to
   * every other broadcasting tab that is connected. The one path typed
   * keys, pastes and codeprints all take.
   */
  sendInput: (tabId: string, bytes: number[]) => void;
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
  retryingTunnelIds: new Set<string>(),
  codeprints: [],
  sessionThemeOverrides: {},
  keys: [],
  settings: DEFAULT_SETTINGS,
  sessions: [],
  activeTabId: 'hosts',
  splitGroup: [],

  systemAppearance: NO_APPEARANCE,
  setSystemAppearance: (appearance) => set({ systemAppearance: appearance }),

  loadError: null,
  clearForLock: () =>
    // The retries stop too: a locked vault has no credentials to
    // reconnect with, and every attempt would fail on the way to the
    // attempt limit.
    set({ servers: [], identities: [], keys: [], portForwardings: [], codeprints: [], retryingTabIds: new Set() }),
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
      const [servers, identities, keys, settings, portForwardings, codeprints, customThemes, sftpBookmarks] =
        await Promise.all([
          ipc.listServers(),
          ipc.listIdentities(),
          ipc.listKeys(),
          ipc.getSettings(),
          ipc.getPortForwardings(),
          ipc.getCodeprints(),
          ipc.getCustomThemes(),
          ipc.getSftpBookmarks(),
        ]);

      cacheAppTheme(resolveAppTheme(settings.app_theme, get().systemAppearance));

      let collections = { portForwardings, codeprints, customThemes };
      try {
        collections = await migrateLegacyStorage(collections);
      } catch (e) {
        // Leave localStorage intact so the next launch can retry rather than
        // losing the user's rules.
        console.error('Could not migrate saved data out of localStorage', e);
      }

      set({ servers, identities, keys, settings, sftpBookmarks, ...collections, loadError: null });
      get().autostartTunnels({ kind: 'launch' });
      get().checkForUpdates();
      void get().restoreTabs();
    } catch (e) {
      console.error('Could not load saved data', e);
      set({ loadError: String(e) });
    }
  },

  restoreTabs: async () => {
    const { settings, sessions, servers, openSession } = get();
    // Nothing to restore onto: an unlock that follows a lock still has the
    // strip it had, and reopening over it would duplicate every tab.
    if (!settings.restore_tabs || sessions.length > 0) return;
    let ids: string[];
    try {
      ids = await ipc.getOpenTabs();
    } catch {
      return;
    }
    // One at a time: a tab's name counts the tabs the host already has, and
    // a host that asks for a passphrase should ask on its own rather than
    // alongside three others.
    for (const id of restoreOrder(ids, servers)) {
      await openSession(id);
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
    cacheAppTheme(resolveAppTheme(settings.app_theme, get().systemAppearance));
    set({ settings });
  },

  sftpRequest: null,
  openInSftp: (serverId, path) => {
    set({ sftpRequest: { serverId, path, nonce: Date.now() }, activeTabId: 'sftp' });
  },
  clearSftpRequest: () => set({ sftpRequest: null }),

  updateAvailable: null,

  checkForUpdates: async (force = false) => {
    const { settings } = get();
    const now = Math.floor(Date.now() / 1000);
    if (!force) {
      if (!settings.check_for_updates) return false;
      if (now - settings.last_update_check < CHECK_INTERVAL_SECS) return false;
    }
    const [latest, current] = await Promise.all([fetchLatestRelease(), getVersion().catch(() => '')]);
    if (!latest) return false;
    set({ updateAvailable: newerVersion(current, latest.version) ? latest : null });
    // The stamp is written through saveSettings so it survives a restart;
    // a failure to write it only means one extra check tomorrow.
    await get().saveSettings({ ...get().settings, last_update_check: now }).catch(() => {});
    return true;
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
    const attempt = async (delayMs: number) => {
      await new Promise((r) => setTimeout(r, delayMs));
      const { retryingTunnelIds, portForwardings, startTunnel } = get();
      // Deactivated meanwhile, or the rule was deleted: nothing to bring back.
      const rule = portForwardings.find((p) => p.id === pfId);
      if (!retryingTunnelIds.has(pfId) || !rule) return;
      try {
        await startTunnel(rule);
        set((s) => { const n = new Set(s.retryingTunnelIds); n.delete(pfId); return { retryingTunnelIds: n }; });
      } catch {
        attempt(Math.min(delayMs * 2, RETRY_MAX_MS));
      }
    };
    attempt(RETRY_FIRST_MS);
  },

  sftpBookmarks: [],

  addBookmark: (bookmark) => {
    set((s) => {
      // The same directory saved twice is one bookmark, not two.
      if (s.sftpBookmarks.some((b) => (b.server_id ?? null) === (bookmark.server_id ?? null) && b.path === bookmark.path)) {
        return s;
      }
      const next = [...s.sftpBookmarks, { id: crypto.randomUUID(), ...bookmark }];
      persist(() => ipc.saveSftpBookmarks(next));
      return { sftpBookmarks: next };
    });
  },

  deleteBookmark: (id) => {
    set((s) => {
      const next = s.sftpBookmarks.filter((b) => b.id !== id);
      persist(() => ipc.saveSftpBookmarks(next));
      return { sftpBookmarks: next };
    });
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

  setSessionTheme: (tabId, themeKey) => {
    set((s) => ({
      sessionThemeOverrides: { ...s.sessionThemeOverrides, [tabId]: themeKey },
    }));
  },

  addSession: (tab) =>
    set((s) => {
      const sessions = [...s.sessions, tab];
      saveOpenTabs(sessions);
      return { sessions, activeTabId: tab.tab_id };
    }),

  removeSession: (tabId) =>
    set((s) => {
      const next = s.sessions.filter((x) => x.tab_id !== tabId);
      const nextActive =
        s.activeTabId === tabId
          ? next.length > 0
            ? next[next.length - 1].tab_id
            : 'hosts'
          : s.activeTabId;
      // The override is keyed on a tab id that will never be reused, so
      // leaving it behind grows the map for the life of the process.
      const { [tabId]: _dropped, ...themeOverrides } = s.sessionThemeOverrides;
      // A retry in flight for a tab that has gone would reconnect a host
      // nobody is looking at; leaving the set tells the loop to stop.
      const retrying = new Set(s.retryingTabIds);
      retrying.delete(tabId);
      saveOpenTabs(next);
      return {
        sessions: next,
        activeTabId: nextActive,
        sessionThemeOverrides: themeOverrides,
        splitGroup: pruneSplit(s.splitGroup, tabId),
        retryingTabIds: retrying,
      };
    }),

  renameSession: (tabId, name) =>
    set((s) => ({
      sessions: s.sessions.map((t) =>
        t.tab_id === tabId ? { ...t, server_name: name } : t
      ),
    })),

  // The tab keeps its id; only the session under it is new. That is what
  // lets a reconnect land in the same terminal.
  updateSessionConnected: (tabId, sessionId) =>
    set((s) => ({
      sessions: s.sessions.map((t) =>
        t.tab_id === tabId
          ? { ...t, session_id: sessionId, status: 'connected', reconnecting: false, connect_id: undefined, error: undefined }
          : t
      ),
    })),

  updateSessionError: (tabId, error) =>
    set((s) => {
      const sessions = s.sessions.map((t) =>
        t.tab_id === tabId ? { ...t, status: 'error' as const, error } : t
      );
      // A tab that could not connect drops out of the restore list, so a
      // host that fails every time is not reopened failing every launch.
      saveOpenTabs(sessions);
      return { sessions };
    }),

  appendSessionLog: (tabId, entry) =>
    set((s) => ({
      sessions: s.sessions.map((t) =>
        t.tab_id === tabId
          ? { ...t, logs: [...(t.logs ?? []), entry] }
          : t
      ),
    })),

  toggleBroadcast: (tabId) =>
    set((s) => ({
      sessions: s.sessions.map((t) =>
        t.tab_id === tabId ? { ...t, broadcast: !t.broadcast } : t
      ),
    })),

  toggleLogging: async (tabId) => {
    const tab = get().sessions.find((t) => t.tab_id === tabId);
    if (!tab || !tab.session_id) return;
    try {
      await ipc.sshSetLog(tab.session_id, tab.server_name, !tab.logging);
      set((s) => ({
        sessions: s.sessions.map((t) => (t.tab_id === tabId ? { ...t, logging: tab.logging ? undefined : 'tab' } : t)),
      }));
    } catch (e) {
      get().setActionError(`Could not ${tab.logging ? 'stop' : 'start'} the log: ${String(e)}`);
    }
  },

  sendInput: (tabId, bytes) => {
    for (const sid of broadcastTargets(get().sessions, tabId)) {
      ipc.sshSendInput(sid, bytes).catch(() => {});
    }
  },

  markDropped: (tabId) => {
    set((s) => ({
      sessions: s.sessions.map((t) =>
        t.tab_id === tabId ? { ...t, status: 'dropped', session_id: null, error: undefined } : t
      ),
    }));

    const { settings, sessions } = get();
    const tab = sessions.find((t) => t.tab_id === tabId);
    // A quick connection has no saved host to connect to again.
    if (!settings.auto_reconnect || !tab || tab.quick_info) return;
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
    // The countdown the banner shows is this, rather than a timer the
    // component keeps: one clock, and it survives a re-render.
    set((s) => ({
      sessions: s.sessions.map((t) => (t.tab_id === tabId ? { ...t, retryAt: Date.now() + delayMs, retryAttempt: attempt } : t)),
    }));
    await new Promise((r) => setTimeout(r, delayMs));

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
    void get().retryLoop(tabId, Math.min(delayMs * 2, RETRY_MAX_MS), attempt + 1);
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
        t.tab_id === tabId ? { ...t, reconnecting: true, error: undefined, retryAt: undefined, gaveUpAfter: undefined } : t
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
      });
      get().updateSessionConnected(tabId, sessionId);
      // A logged tab goes on being logged, to a new file for the new session.
      // A host-logged tab was reopened logging by the backend; a tab-logged
      // one is asked for again, to a new file for the new session.
      if (tab.logging === 'tab') {
        const ok = await ipc.sshSetLog(sessionId, tab.server_name, true).then(() => true, () => false);
        set((s) => ({ sessions: s.sessions.map((t) => (t.tab_id === tabId ? { ...t, logging: ok ? 'tab' : undefined } : t)) }));
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

  openSession: async (serverId) => {
    const { servers, identities, sessions, detectServerOs } = get();
    const server = servers.find((s) => s.id === serverId);
    if (!server) return;

    // Resolve credentials: identity takes priority, then server-direct credentials
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
          tab_id: connectId,
          session_id: null,
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
    const { username, authType, authValue } = resolved;

    // Resolved before the tab exists, since a broken jump chain should reach
    // the session's own error view like any other failure to connect.
    let jumps: JumpHopParams[] = [];
    const ok = await startSession(
      connectId,
      {
        tab_id: connectId,
        session_id: null,
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
    // The backend opened the log before connecting; the tab only needs to know.
    if (ok && server.log_sessions) {
      set((s) => ({ sessions: s.sessions.map((t) => (t.tab_id === connectId ? { ...t, logging: 'host' } : t)) }));
    }
    if (ok) get().autostartTunnels({ kind: 'connect', serverId });
  },

  quickConnect: async (host, port, username, authType, authValue) => {
    const connectId = crypto.randomUUID();
    await startSession(
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

  setActiveTab: (id) => set({ activeTabId: id }),

  settingsSection: 'appearance',

  openSettings: (section) =>
    set((s) => ({
      activeTabId: 'settings',
      settingsSection: section ?? s.settingsSection,
    })),

  splitWith: (anchorTabId, droppedTabId) =>
    set((s) => {
      if (anchorTabId === droppedTabId) return {};
      const ids = new Set(s.sessions.map((t) => t.tab_id));
      if (!ids.has(anchorTabId) || !ids.has(droppedTabId)) return {};
      const base = s.splitGroup.includes(anchorTabId) ? s.splitGroup : [anchorTabId];
      if (base.includes(droppedTabId) || base.length >= MAX_SPLIT) return {};
      const members = new Set([...base, droppedTabId]);
      // Strip order, so panes read the way the tabs do.
      return { splitGroup: s.sessions.map((t) => t.tab_id).filter((id) => members.has(id)) };
    }),

  unsplit: (tabId) => set((s) => ({ splitGroup: pruneSplit(s.splitGroup, tabId) })),
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

  useAppStore.setState((s) => {
    const sessions = [...s.sessions, tab];
    saveOpenTabs(sessions);
    return { sessions, activeTabId: connectId };
  });

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

