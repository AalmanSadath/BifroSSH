import * as ipc from '../../ipc';
import { cleanTitle } from '../../tabName';
import { clampZoom } from '../../zoom';
import { nextActivity, watched, type Activity, type Mark } from '../../activity';
import type { LogEntry, SessionTab } from '../../types';
import { saveOpenTabs } from '../persistence';
import { startOrStopRecording } from '../recording';
import type { Slice } from '../types';
import { pruneSplit } from './splits';

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

/** The tab strip, which tab is in front, and what is kept per tab. */
export interface SessionsSlice {
  sessions: SessionTab[];
  activeTabId: string | null;
  setActiveTab: (id: string | null) => void;

  /** Keyed by tab id. */
  sessionThemeOverrides: Record<string, string>;
  setSessionTheme: (tabId: string, themeKey: string) => void;

  /**
   * A tab's own terminal font size, keyed by tab id; a tab with no entry
   * follows the setting. Not saved, the same as the theme override: a zoom
   * is for the session in front of you.
   */
  sessionZoom: Record<string, number>;
  /**
   * What each tab's shell is doing, from the OSC 133 marks it sends. Absent
   * for a tab whose shell sends none, which is most of them until the
   * integration snippet is installed.
   */
  sessionActivity: Record<string, Activity>;
  /** One mark from a tab's output, moving it between running and idle. */
  markActivity: (tabId: string, mark: Mark) => void;
  /** Steps the active tab's size by `delta` points, within the setting's range. */
  zoomSession: (tabId: string, delta: number) => void;
  /** Drops the tab's own size so it follows the setting again. */
  resetZoom: (tabId: string) => void;

  addSession: (tab: SessionTab) => void;
  removeSession: (tabId: string) => void;
  renameSession: (tabId: string, name: string) => void;
  updateSessionConnected: (tabId: string, sessionId: string) => void;
  updateSessionError: (tabId: string, error: string) => void;
  appendSessionLog: (tabId: string, entry: LogEntry) => void;
  toggleBroadcast: (tabId: string) => void;
  /** Starts or stops writing the tab's output to a file; the banner says if it could not. */
  toggleLogging: (tabId: string) => Promise<void>;
  /** Starts or stops recording the tab as asciicast; the banner says if it could not. */
  toggleRecording: (tabId: string) => Promise<void>;
  /**
   * Input from `tabId` to its own session, and when the tab broadcasts, to
   * every other broadcasting tab that is connected. The one path typed
   * keys, pastes and codeprints all take.
   */
  sendInput: (tabId: string, bytes: number[]) => void;
}

export const createSessionsSlice: Slice<SessionsSlice> = (set, get) => ({
  sessions: [],
  activeTabId: 'hosts',
  sessionThemeOverrides: {},
  sessionZoom: {},
  sessionActivity: {},

  setActiveTab: (id) =>
    set((s) => {
      // Opening a tab is what reads whatever it was holding, so a result that
      // arrived while it was elsewhere starts its short goodbye here.
      const at = id === null ? undefined : watched(s.sessionActivity[id], Date.now());
      return {
        activeTabId: id,
        sessionActivity: at && id !== null ? { ...s.sessionActivity, [id]: at } : s.sessionActivity,
      };
    }),

  setSessionTheme: (tabId, themeKey) => {
    set((s) => ({
      sessionThemeOverrides: { ...s.sessionThemeOverrides, [tabId]: themeKey },
    }));
  },

  zoomSession: (tabId, delta) =>
    set((s) => ({
      sessionZoom: {
        ...s.sessionZoom,
        [tabId]: clampZoom((s.sessionZoom[tabId] ?? s.settings.font_size) + delta),
      },
    })),

  resetZoom: (tabId) =>
    set((s) => {
      const { [tabId]: _dropped, ...rest } = s.sessionZoom;
      return { sessionZoom: rest };
    }),

  markActivity: (tabId, mark) =>
    set((s) => ({
      sessionActivity: {
        ...s.sessionActivity,
        // Whether anyone was there for it decides how long its mark stays.
        [tabId]: nextActivity(s.sessionActivity[tabId], mark, Date.now(), s.activeTabId === tabId),
      },
    })),

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
      const { [tabId]: _zoom, ...zoom } = s.sessionZoom;
      const { [tabId]: _activity, ...activity } = s.sessionActivity;
      // A retry in flight for a tab that has gone would reconnect a host
      // nobody is looking at; leaving the set tells the loop to stop.
      const retrying = new Set(s.retryingTabIds);
      retrying.delete(tabId);
      saveOpenTabs(next);
      return {
        sessions: next,
        activeTabId: nextActive,
        sessionThemeOverrides: themeOverrides,
        sessionZoom: zoom,
        sessionActivity: activity,
        splitGroup: pruneSplit(s.splitGroup, tabId),
        splitWidths: [],
        retryingTabIds: retrying,
      };
    }),

  renameSession: (tabId, name) =>
    set((s) => ({
      sessions: s.sessions.map((t) =>
        t.tab_id === tabId ? { ...t, title: cleanTitle(name, t.server_name) } : t
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

  updateSessionError: (tabId, error) => {
    set((s) => {
      const sessions = s.sessions.map((t) =>
        t.tab_id === tabId ? { ...t, status: 'error' as const, error } : t
      );
      // A tab that could not connect drops out of the restore list, so a
      // host that fails every time is not reopened failing every launch.
      saveOpenTabs(sessions);
      return { sessions };
    });
    get().recordError('connecting a tab', error);
  },

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

  toggleRecording: async (tabId) => {
    const tab = get().sessions.find((t) => t.tab_id === tabId);
    if (!tab || !tab.session_id) return;
    const on = !tab.recording;
    try {
      const path = await startOrStopRecording(tab.session_id, tabId, tab.server_name, on);
      set((s) => ({
        sessions: s.sessions.map((t) => (t.tab_id === tabId ? { ...t, recording: path ?? undefined } : t)),
        savedRecording: on ? s.savedRecording : (tab.recording ?? null),
      }));
    } catch (e) {
      get().setActionError(`Could not ${on ? 'start' : 'stop'} the recording: ${String(e)}`);
    }
  },

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
});
