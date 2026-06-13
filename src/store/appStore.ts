import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Identity, KeyEntry, LogEntry, Server, SessionTab, Settings } from '../types';
import type { NamedTheme } from '../styles/themes';

const CUSTOM_THEMES_KEY = 'bifrossh_custom_themes';

function loadCustomThemesFromStorage(): Record<string, NamedTheme> {
  try {
    const raw = localStorage.getItem(CUSTOM_THEMES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

const DEFAULT_SETTINGS: Settings = {
  theme: 'bifrossh-dark',
  font_size: 14,
  font_family: 'monospace',
  cursor_style: 'block',
  cursor_blink: true,
  app_theme: 'dark',
  connection_timeout_secs: 60,
  show_hover_hints: true,
};

interface AppStore {
  servers: Server[];
  identities: Identity[];
  keys: KeyEntry[];
  settings: Settings;
  sessions: SessionTab[];
  activeTabId: string | null;

  loadAll: () => Promise<void>;

  saveServer: (server: Partial<Server> & { name: string; host: string; port: number }) => Promise<void>;
  deleteServer: (id: string) => Promise<void>;
  detectServerOs: (serverId: string, username: string, authType: string, authValue: string) => Promise<void>;

  importKey: (name: string, path: string, passphrase: string | null, storeContent: boolean) => Promise<void>;
  saveKeyFromContent: (name: string, content: string, passphrase: string | null) => Promise<void>;
  generateKey: (algorithm: string) => Promise<{ private_pem: string; public_openssh: string }>;
  getKeyContent: (keyId: string) => Promise<{ private_pem: string; public_openssh: string | null }>;
  updateKey: (keyId: string, name: string, content: string, passphrase: string | null) => Promise<void>;
  deleteKey: (id: string) => Promise<void>;

  saveIdentity: (identity: Partial<Identity> & { name: string; username: string }, password?: string) => Promise<void>;
  deleteIdentity: (id: string) => Promise<void>;

  saveSettings: (settings: Settings) => Promise<void>;

  customThemes: Record<string, NamedTheme>;
  saveCustomTheme: (id: string, theme: NamedTheme) => void;
  deleteCustomTheme: (id: string) => void;

  addSession: (tab: SessionTab) => void;
  removeSession: (sessionId: string) => void;
  renameSession: (sessionId: string, name: string) => void;
  updateSessionConnected: (connectId: string, sessionId: string) => void;
  updateSessionError: (connectId: string, error: string) => void;
  appendSessionLog: (connectId: string, entry: LogEntry) => void;
  openSession: (serverId: string, fallback?: (serverId: string) => void) => Promise<void>;
  setActiveTab: (id: string | null) => void;
}

export const useAppStore = create<AppStore>((set, get) => ({
  servers: [],
  identities: [],
  customThemes: loadCustomThemesFromStorage(),
  keys: [],
  settings: DEFAULT_SETTINGS,
  sessions: [],
  activeTabId: 'hosts',

  loadAll: async () => {
    const [servers, identities, keys, settings] = await Promise.all([
      invoke<Server[]>('list_servers'),
      invoke<Identity[]>('list_identities'),
      invoke<KeyEntry[]>('list_keys'),
      invoke<Settings>('get_settings'),
    ]);
    set({ servers, identities, keys, settings });
  },

  saveServer: async (server) => {
    const saved = await invoke<Server>('save_server', {
      server: { id: server.id ?? '', ...server },
    });
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
    await invoke('delete_server', { serverId: id });
    set((s) => ({ servers: s.servers.filter((x) => x.id !== id) }));
  },

  detectServerOs: async (serverId, username, authType, authValue) => {
    try {
      const detectedOs = await invoke<string>('detect_server_os', {
        serverId, username, authType, authValue,
      });
      set((s) => ({
        servers: s.servers.map((srv) =>
          srv.id === serverId ? { ...srv, os: detectedOs } : srv
        ),
      }));
    } catch (e) {
      console.warn('[OS detect]', e);
      set((s) => ({
        servers: s.servers.map((srv) =>
          srv.id === serverId ? { ...srv, os: 'server' } : srv
        ),
      }));
    }
  },

  importKey: async (name, path, passphrase, storeContent) => {
    const key = await invoke<KeyEntry>('import_key_from_path', {
      name,
      path,
      passphrase,
      storeContent,
    });
    set((s) => ({ keys: [...s.keys, key] }));
  },

  saveKeyFromContent: async (name, content, passphrase) => {
    const key = await invoke<KeyEntry>('save_key_from_content', { name, content, passphrase });
    set((s) => ({ keys: [...s.keys, key] }));
  },

  generateKey: async (algorithm) => {
    return invoke<{ private_pem: string; public_openssh: string }>('generate_key', { algorithm });
  },

  getKeyContent: async (keyId) => {
    return invoke<{ private_pem: string; public_openssh: string | null }>('get_key_content', { keyId });
  },

  updateKey: async (keyId, name, content, passphrase) => {
    await invoke('update_key', { keyId, name, content, passphrase });
    const keys = await invoke<KeyEntry[]>('list_keys');
    set({ keys });
  },

  deleteKey: async (id) => {
    await invoke('delete_key', { keyId: id });
    set((s) => ({
      keys: s.keys.filter((k) => k.id !== id),
    }));
  },

  saveIdentity: async (identity, password?) => {
    const saved = await invoke<Identity>('save_identity', {
      identity: { id: identity.id ?? '', ...identity },
      password: password ?? null,
    });
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
    await invoke('delete_identity', { identityId: id });
    set((s) => ({
      identities: s.identities.filter((x) => x.id !== id),
      servers: s.servers.map((srv) =>
        srv.identity_id === id ? { ...srv, identity_id: null } : srv
      ),
    }));
  },

  saveSettings: async (settings) => {
    await invoke('save_settings', { settings });
    set({ settings });
  },

  saveCustomTheme: (id, theme) => {
    set((s) => {
      const next = { ...s.customThemes, [id]: theme };
      localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(next));
      return { customThemes: next };
    });
  },

  deleteCustomTheme: (id) => {
    set((s) => {
      const next = { ...s.customThemes };
      delete next[id];
      localStorage.setItem(CUSTOM_THEMES_KEY, JSON.stringify(next));
      return { customThemes: next };
    });
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
      return { sessions: next, activeTabId: nextActive };
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

  openSession: async (serverId, fallback) => {
    const { servers, identities, sessions, detectServerOs } = get();
    const server = servers.find((s) => s.id === serverId);
    if (!server) return;
    const identity = identities.find((i) => i.id === server.identity_id);
    if (!identity) { fallback?.(serverId); return; }

    const connectId = crypto.randomUUID();
    const existing = sessions.filter((s) => s.server_id === serverId).length;
    const tabName = existing === 0 ? server.name : `${server.name} (${existing})`;

    // Set up listener BEFORE invoking so no log events are lost to race conditions
    const unlisten = await listen<LogEntry>(`ssh-connect-log:${connectId}`, (event) => {
      get().appendSessionLog(connectId, event.payload);
    });

    set((s) => ({
      sessions: [...s.sessions, {
        session_id: connectId,
        server_name: tabName,
        server_id: serverId,
        status: 'connecting',
        connect_id: connectId,
        logs: [],
      }],
      activeTabId: connectId,
    }));

    try {
      const isPasswordAuth = identity.encrypted_password === '[stored]';
      const authType = isPasswordAuth ? 'password' : 'key';
      const authValue = isPasswordAuth
        ? await invoke<string>('get_identity_password', { identityId: identity.id })
        : (identity.key_id ?? '');

      const sessionId = await invoke<string>('ssh_connect', {
        request: {
          server_id: serverId,
          username: identity.username,
          auth_type: authType,
          auth_value: authValue,
          cols: 80,
          rows: 24,
          connect_id: connectId,
        },
      });
      unlisten();
      get().updateSessionConnected(connectId, sessionId);
      if (server.os === '') detectServerOs(serverId, identity.username, authType, authValue);
    } catch (err) {
      unlisten();
      get().updateSessionError(connectId, String(err));
    }
  },

  setActiveTab: (id) => set({ activeTabId: id }),
}));
