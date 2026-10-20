import * as ipc from '../../ipc';
import { getVersion } from '@tauri-apps/api/app';
import { fetchLatestRelease, newerVersion, type Release } from '../../updates';
import type { Settings, SettingsSection } from '../../types';
import type { NamedTheme } from '../../styles/themes';
import { DEFAULT_SETTINGS } from '../defaults';
import { persist } from '../persistence';
import { cacheAppTheme, resolveAppTheme } from '../themeCache';
import type { Slice } from '../types';

/** Settings, the themes the user made, and the update check that writes back to settings. */
export interface SettingsSlice {
  settings: Settings;
  saveSettings: (settings: Settings) => Promise<void>;

  /**
   * Which category the settings panel is showing. In the store rather than
   * in the panel so the palette and the panel's own links can open one.
   */
  settingsSection: SettingsSection;
  /** Shows the settings panel, on the category asked for. */
  openSettings: (section?: SettingsSection) => void;

  customThemes: Record<string, NamedTheme>;
  saveCustomTheme: (id: string, theme: NamedTheme) => void;
  deleteCustomTheme: (id: string) => void;

  /** A release newer than this build, once a check has found one. */
  updateAvailable: Release | null;
  /**
   * Asks GitHub for the latest release. At launch only when the setting
   * allows, and whenever forced from the Settings page. Resolves to whether
   * the check ran; never throws.
   */
  checkForUpdates: (force?: boolean) => Promise<boolean>;
}

export const createSettingsSlice: Slice<SettingsSlice> = (set, get) => ({
  settings: DEFAULT_SETTINGS,

  saveSettings: async (settings) => {
    await ipc.saveSettings(settings);
    cacheAppTheme(resolveAppTheme(settings.app_theme, get().systemAppearance));
    set({ settings });
  },

  settingsSection: 'appearance',

  openSettings: (section) =>
    set((s) => ({
      activeTabId: 'settings',
      settingsSection: section ?? s.settingsSection,
    })),

  customThemes: {},

  saveCustomTheme: (id, theme) => {
    set((s) => {
      const next = { ...s.customThemes, [id]: theme };
      persist(get, () => ipc.saveCustomThemes(next));
      return { customThemes: next };
    });
  },

  deleteCustomTheme: (id) => {
    set((s) => {
      const next = { ...s.customThemes };
      delete next[id];
      persist(get, () => ipc.saveCustomThemes(next));
      return { customThemes: next };
    });
  },

  updateAvailable: null,

  checkForUpdates: async (force = false) => {
    const { settings } = get();
    const now = Math.floor(Date.now() / 1000);
    // Every launch rather than once a day: what a check finds is not kept,
    // so a skipped one would leave a known newer release unannounced.
    if (!force && !settings.check_for_updates) return false;
    const [latest, current] = await Promise.all([fetchLatestRelease(), getVersion().catch(() => '')]);
    if (!latest) return false;
    set({ updateAvailable: latest !== 'none' && newerVersion(current, latest.version) ? latest : null });
    // The stamp is written through saveSettings so About can say when the
    // last check ran; a failure to write it costs nothing else.
    await get().saveSettings({ ...get().settings, last_update_check: now }).catch(() => {});
    return true;
  },
});
