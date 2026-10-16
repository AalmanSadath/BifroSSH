import * as ipc from '../../ipc';
import { restoreOrder } from '../../sessionRestore';
import type { OpenTab } from '../../types';
import { migrateLegacyStorage } from '../persistence';
import { cacheAppTheme, resolveAppTheme } from '../themeCache';
import type { Slice } from '../types';

/** Reading everything in once the vault is open, and putting the tabs back. */
export interface BootstrapSlice {
  /** Set when `loadAll` could not read the saved data; see there. */
  loadError: string | null;
  loadAll: () => Promise<void>;

  /**
   * Opens the tabs that were open when the app last ran, one at a time.
   * Off when the setting says so, and a no-op once anything is open.
   */
  restoreTabs: () => Promise<void>;
}

export const createBootstrapSlice: Slice<BootstrapSlice> = (set, get) => ({
  loadError: null,

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
      get().recordError('loading saved data', String(e));
    }
  },

  restoreTabs: async () => {
    const { settings, sessions, servers, openSession } = get();
    // Nothing to restore onto: an unlock that follows a lock still has the
    // strip it had, and reopening over it would duplicate every tab.
    if (!settings.restore_tabs || sessions.length > 0) return;
    let saved: OpenTab[];
    try {
      saved = await ipc.getOpenTabs();
    } catch {
      return;
    }
    // One at a time: a tab's name counts the tabs the host already has, and
    // a host that asks for a passphrase should ask on its own rather than
    // alongside three others.
    for (const tab of restoreOrder(saved, servers)) {
      await openSession(tab.server_id, tab.title ?? undefined);
    }
  },
});
