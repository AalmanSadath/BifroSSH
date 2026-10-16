import * as ipc from '../../ipc';
import { UNKNOWN_OS } from '../../types';
import type { AuthType, GeneratedKey, Identity, IdentityInput, JumpHopParams, KeyContent, KeyEntry, Server, ServerInput } from '../../types';
import { dropQueuedCommands } from '../persistence';
import type { Slice } from '../types';

/** The vault's hosts, keys and identities, as copies of what the backend holds. */
export interface RecordsSlice {
  servers: Server[];
  identities: Identity[];
  keys: KeyEntry[];

  saveServer: (server: ServerInput, password?: string) => Promise<void>;
  deleteServer: (id: string) => Promise<void>;
  deleteServers: (ids: string[]) => Promise<void>;
  setServersGroup: (ids: string[], group: string | null) => Promise<void>;
  addServersTag: (ids: string[], tag: string) => Promise<void>;
  removeServersTag: (ids: string[], tag: string) => Promise<void>;
  detectServerOs: (serverId: string, username: string, authType: AuthType, authValue: string, jumps?: JumpHopParams[]) => Promise<void>;

  importKey: (name: string, path: string, passphrase: string | null, storeContent: boolean) => Promise<void>;
  saveKeyFromContent: (name: string, content: string, passphrase: string | null, certificate?: string | null) => Promise<void>;
  generateKey: (algorithm: string, passphrase?: string | null) => Promise<GeneratedKey>;
  getKeyContent: (keyId: string) => Promise<KeyContent>;
  updateKey: (keyId: string, name: string, content: string, passphrase: string | null) => Promise<void>;
  /** Puts a certificate on a key, or takes it off with null; refused with the reason when it is not this key's. */
  setKeyCertificate: (keyId: string, certificate: string | null) => Promise<void>;
  deleteKey: (id: string) => Promise<void>;

  saveIdentity: (identity: IdentityInput, password?: string) => Promise<void>;
  deleteIdentity: (id: string) => Promise<void>;
}

export const createRecordsSlice: Slice<RecordsSlice> = (set, get) => ({
  servers: [],
  identities: [],
  keys: [],

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

  deleteServer: (id) => get().deleteServers([id]),

  deleteServers: async (ids) => {
    if (ids.length === 1) await ipc.deleteServer(ids[0]);
    else await ipc.deleteServers(ids);
    // Read back rather than filtered here: the backend also cleared what the
    // remaining hosts said about these (a jump host, say), and the copy held
    // here would otherwise keep pointing at hosts that are gone. Bookmarks go
    // too, or the next bookmark save would write the removed ones back.
    const servers = await ipc.listServers();
    ids.forEach((id) => dropQueuedCommands(id));
    set((s) => ({
      servers,
      sftpBookmarks: s.sftpBookmarks.filter((b) => !b.server_id || !ids.includes(b.server_id)),
      commandHistory: Object.fromEntries(
        Object.entries(s.commandHistory).filter(([id]) => !ids.includes(id)),
      ),
    }));
  },

  setServersGroup: async (ids, group) => {
    const servers = await ipc.setServersGroup(ids, group);
    set({ servers });
  },

  addServersTag: async (ids, tag) => {
    set({ servers: await ipc.addServersTag(ids, tag) });
  },

  removeServersTag: async (ids, tag) => {
    set({ servers: await ipc.removeServersTag(ids, tag) });
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

  saveKeyFromContent: async (name, content, passphrase, certificate) => {
    const key = await ipc.saveKeyFromContent(name, content, passphrase, certificate ?? null);
    set((s) => ({ keys: [...s.keys, key] }));
  },

  generateKey: async (algorithm, passphrase) => {
    return ipc.generateKey(algorithm, passphrase ?? null);
  },

  getKeyContent: async (keyId) => {
    return ipc.getKeyContent(keyId);
  },

  setKeyCertificate: async (keyId, certificate) => {
    const key = await ipc.setKeyCertificate(keyId, certificate);
    set((s) => ({ keys: s.keys.map((k) => (k.id === keyId ? key : k)) }));
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
});
