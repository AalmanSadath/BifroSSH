import * as ipc from '../../ipc';
import type { Codeprint, SftpBookmark } from '../../types';
import { persist } from '../persistence';
import type { Slice } from '../types';

/** Codeprints, SFTP bookmarks, and the path a terminal asked the SFTP panel to show. */
export interface LibrarySlice {
  codeprints: Codeprint[];
  addCodeprint: (cp: Omit<Codeprint, 'id'>) => void;
  updateCodeprint: (id: string, cp: Omit<Codeprint, 'id'>) => void;
  deleteCodeprint: (id: string) => void;

  /** Directories saved for one click in the SFTP panel. */
  sftpBookmarks: SftpBookmark[];
  addBookmark: (bookmark: Omit<SftpBookmark, 'id'>) => void;
  deleteBookmark: (id: string) => void;

  /**
   * A place the SFTP panel has been asked to show: set by a click on a
   * path in a terminal, cleared by the panel once it is there. The nonce
   * makes two clicks on the same path two requests.
   */
  sftpRequest: { serverId: string; path: string; nonce: number } | null;
  openInSftp: (serverId: string, path: string) => void;
  clearSftpRequest: () => void;
}

export const createLibrarySlice: Slice<LibrarySlice> = (set, get) => ({
  codeprints: [],

  addCodeprint: (cp) => {
    set((s) => {
      const next = [...s.codeprints, { id: crypto.randomUUID(), ...cp }];
      persist(get, () => ipc.saveCodeprints(next));
      return { codeprints: next };
    });
  },

  updateCodeprint: (id, cp) => {
    set((s) => {
      const next = s.codeprints.map((c) => c.id === id ? { ...c, ...cp } : c);
      persist(get, () => ipc.saveCodeprints(next));
      return { codeprints: next };
    });
  },

  deleteCodeprint: (id) => {
    set((s) => {
      const next = s.codeprints.filter((c) => c.id !== id);
      persist(get, () => ipc.saveCodeprints(next));
      return { codeprints: next };
    });
  },

  sftpBookmarks: [],

  addBookmark: (bookmark) => {
    set((s) => {
      // The same directory saved twice is one bookmark, not two.
      if (s.sftpBookmarks.some((b) => (b.server_id ?? null) === (bookmark.server_id ?? null) && b.path === bookmark.path)) {
        return s;
      }
      const next = [...s.sftpBookmarks, { id: crypto.randomUUID(), ...bookmark }];
      persist(get, () => ipc.saveSftpBookmarks(next));
      return { sftpBookmarks: next };
    });
  },

  deleteBookmark: (id) => {
    set((s) => {
      const next = s.sftpBookmarks.filter((b) => b.id !== id);
      persist(get, () => ipc.saveSftpBookmarks(next));
      return { sftpBookmarks: next };
    });
  },

  sftpRequest: null,
  openInSftp: (serverId, path) => {
    set({ sftpRequest: { serverId, path, nonce: Date.now() }, activeTabId: 'sftp' });
  },
  clearSftpRequest: () => set({ sftpRequest: null }),
});
