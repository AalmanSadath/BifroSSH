import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import type { Identity, KeyEntry, Server, SessionTab, Settings } from '../types';

const DEFAULT_SETTINGS: Settings = {
  theme: 'bifrossh-dark',
  font_size: 14,
  font_family: 'monospace',
  cursor_style: 'block',
  cursor_blink: true,
  app_theme: 'dark',
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

  saveIdentity: (identity: Partial<Identity> & { name: string; username: string; key_id: string }) => Promise<void>;
  deleteIdentity: (id: string) => Promise<void>;

  saveSettings: (settings: Settings) => Promise<void>;

  addSession: (tab: SessionTab) => void;
  removeSession: (sessionId: string) => void;
  renameSession: (sessionId: string, name: string) => void;
  setActiveTab: (id: string | null) => void;
}

export const useAppStore = create<AppStore>((set, _get) => ({
  servers: [],
  identities: [],
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

  saveIdentity: async (identity) => {
    const saved = await invoke<Identity>('save_identity', {
      identity: { id: identity.id ?? '', ...identity },
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

  setActiveTab: (id) => set({ activeTabId: id }),
}));
