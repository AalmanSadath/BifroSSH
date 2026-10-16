import { withError, type DiagError } from '../../diagnostics';
import type { SystemAppearance } from '../../types';
import { NO_APPEARANCE } from '../themeCache';
import type { Slice } from '../types';

/** What belongs to the app as a whole: the desktop's look, errors, the lock, recordings. */
export interface AppSlice {
  /** What the desktop reports about its own theme and accent. */
  systemAppearance: SystemAppearance;
  setSystemAppearance: (appearance: SystemAppearance) => void;

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
  /**
   * The last errors this session showed, oldest first, for the diagnostics
   * that About can copy. Banners, tab failures, the crash screen and
   * anything thrown that nothing caught all land here.
   */
  recentErrors: DiagError[];
  recordError: (where: string, message: string) => void;

  /** A recording just finished, for the notice that offers to play it. */
  savedRecording: string | null;
  setSavedRecording: (path: string | null) => void;
  /** The recording the Recordings panel is playing, if any. */
  playingRecording: string | null;
  /** Plays a recording in the Recordings panel, opening the panel; null stops it. */
  playRecording: (path: string | null) => void;
}

export const createAppSlice: Slice<AppSlice> = (set, get) => ({
  systemAppearance: NO_APPEARANCE,
  setSystemAppearance: (appearance) => set({ systemAppearance: appearance }),

  clearForLock: () =>
    // The retries stop too: a locked vault has no credentials to
    // reconnect with, and every attempt would fail on the way to the
    // attempt limit.
    set({ servers: [], identities: [], keys: [], portForwardings: [], codeprints: [], retryingTabIds: new Set(), hostProbes: {} }),

  actionError: null,
  setActionError: (message) => {
    set({ actionError: message });
    if (message) get().recordError('banner', message);
  },
  recentErrors: [],
  recordError: (where, message) =>
    set((s) => ({ recentErrors: withError(s.recentErrors, { at: Date.now(), where, message }) })),

  savedRecording: null,
  setSavedRecording: (path) => set({ savedRecording: path }),
  playingRecording: null,
  playRecording: (path) => set(path ? { playingRecording: path, activeTabId: 'recordings' } : { playingRecording: null }),
});
