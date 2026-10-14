import { useEffect, useRef } from 'react';
import { emitTo, listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import * as ipc from '../ipc';
import { useAppStore } from '../store/appStore';
import { remember } from '../commandHistory';
import { useAppChrome } from '../useAppChrome';
import {
  holdOutput, parsePayload, screenOf,
  type DetachedAction, type Ended, type Mirror, type Opening, type Returned,
} from '../detach';
import { stashScreen, terminalFor } from '../terminalRegistry';
import { tabLabel } from '../tabName';
import { zoomPercent } from '../zoom';
import { WINDOW_ACTIONS, actionFor, resolve as resolveShortcuts } from '../shortcuts';
import TerminalView from './TerminalView';
import { useHint } from './shared/useHint';

/** Asks the main window to do what only it can. */
function toMain(action: DetachedAction) {
  void emitTo('main', 'detached-action', action).catch(() => {});
}

/** Set once this window has started giving its tab back, so it only does so once. */
let leaving = false;

/**
 * Gives the tab back to the main window and closes this one.
 *
 * The same handover as going out, the other way: hold the output, serialise
 * the screen once everything before the hold is on it, leave both for the
 * main window, and go. The main window hears the window has gone, from the
 * backend, and takes the tab back with what was left. `ended` says the
 * session itself is over, so there is nothing to hold.
 */
async function leave(tabId: string, ended?: Ended) {
  if (leaving) return;
  leaving = true;
  const st = useAppStore.getState();
  const sessionId = st.sessions[0]?.session_id;
  try {
    if (!ended && sessionId) await holdOutput(sessionId);
    const term = terminalFor(tabId);
    const back: Returned = {
      // A shell that exited closes its tab; there is no screen to keep.
      screen: ended?.kind === 'exited' || !term ? '' : await screenOf(term),
      zoom: st.sessionZoom[tabId],
      ended,
    };
    await ipc.windowStash(tabId, JSON.stringify(back));
  } finally {
    // Whatever failed above, the window still goes, and the main window still
    // takes the tab back; at worst without its scrollback.
    await getCurrentWindow().destroy();
  }
}

/** Draws from what the main window sent: the tab, the settings, the hosts and the themes. */
function applyMirror(m: Mirror) {
  useAppStore.setState({
    sessions: [m.tab],
    settings: m.settings,
    servers: m.servers,
    customThemes: m.customThemes,
    sessionThemeOverrides: m.themeOverride ? { [m.tab.tab_id]: m.themeOverride } : {},
  });
  getCurrentWindow().setTitle(tabLabel(m.tab)).catch(() => {});
}

/**
 * Points the store's actions that the terminal calls at the right window.
 *
 * The terminal is the same component as in the main window, calling the same
 * store actions. Here the store holds only this tab, so the actions that need
 * the rest of the app go to the main window, and the ones about the session
 * ending give the tab back, since reconnecting is the main window's job.
 */
function routeActions(tabId: string) {
  const { getState: get, setState: set } = useAppStore;
  set({
    activeTabId: tabId,
    sendInput: (id, bytes) => {
      const tab = get().sessions[0];
      if (!tab?.session_id) return;
      // Broadcast reaches the other tabs, which only the main window knows.
      if (tab.broadcast) toMain({ action: 'sendInput', tabId: id, bytes });
      else ipc.sshSendInput(tab.session_id, bytes).catch(() => {});
    },
    learnCommand: (serverId, command) => {
      if (!serverId) return;
      // Here for this terminal's suggestions, and there to be saved.
      set((s) => ({
        commandHistory: { ...s.commandHistory, [serverId]: remember(s.commandHistory[serverId] ?? [], command) },
      }));
      toMain({ action: 'learnCommand', serverId, command });
    },
    openInSftp: (serverId, path) => toMain({ action: 'openInSftp', serverId, path }),
    markActivity: (id, mark) => toMain({ action: 'markActivity', tabId: id, mark }),
    markDropped: (_id, endedWith) => { void leave(tabId, { kind: 'dropped', endedWith }); },
    removeSession: () => { void leave(tabId, { kind: 'exited' }); },
    reconnectSession: async () => {},
    stopRetrying: () => {},
    setActiveTab: () => {},
  });
}

/** A window holding one terminal tab, moved out of the main window. */
export default function DetachedTerminal({ tabId }: { tabId: string }) {
  const chrome = useAppChrome();
  const hint = useHint();
  const tab = useAppStore((s) => s.sessions.find((t) => t.tab_id === tabId));
  const settings = useAppStore((s) => s.settings);
  const zoom = useAppStore((s) => s.sessionZoom[tabId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const opening = parsePayload<Opening>(await ipc.windowTake(tabId).catch(() => null));
      if (cancelled) return;
      // Opened with nothing to show, which only a reload of this window can
      // do: the payload was taken by the first load. The tab is still the
      // main window's, so closing hands it back.
      if (!opening) {
        void leave(tabId);
        return;
      }
      if (opening.screen) stashScreen(tabId, opening.screen);
      routeActions(tabId);
      applyMirror(opening);
      if (opening.zoom !== undefined) useAppStore.setState({ sessionZoom: { [tabId]: opening.zoom } });
    })();
    return () => { cancelled = true; };
  }, [tabId]);

  useEffect(() => {
    const subscriptions = [
      listen<Mirror>('detached-sync', (e) => { if (e.payload.tab.tab_id === tabId) applyMirror(e.payload); }),
      listen<string>('detached-reattach', (e) => { if (e.payload === tabId) void leave(tabId); }),
      // A locked vault shows nothing, so the terminal goes back behind the
      // main window's lock screen.
      listen('vault-locked', () => { void leave(tabId); }),
      // Closing the window is giving the tab back, not closing the session.
      getCurrentWindow().onCloseRequested((e) => {
        e.preventDefault();
        void leave(tabId);
      }),
    ];
    return () => { subscriptions.forEach((s) => s.then((f) => f())); };
  }, [tabId]);

  // The window's own shortcuts, those that make sense for one tab: zoom, and
  // close. The terminal's find, copy and paste are its own and work as ever.
  const shortcutsRef = useRef(resolveShortcuts(settings.shortcuts));
  shortcutsRef.current = resolveShortcuts(settings.shortcuts);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = actionFor(e, shortcutsRef.current, WINDOW_ACTIONS);
      const st = useAppStore.getState();
      switch (action) {
        case 'zoom-in': st.zoomSession(tabId, 1); break;
        case 'zoom-out': st.zoomSession(tabId, -1); break;
        case 'zoom-reset': st.resetZoom(tabId); break;
        case 'close-tab': {
          const sessionId = st.sessions[0]?.session_id;
          if (sessionId) ipc.sshDisconnect(sessionId).catch(() => {});
          break;
        }
        default:
          return;
      }
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [tabId]);

  const zoomed = zoomPercent(zoom, settings.font_size);

  return (
    <div className={chrome.className} style={chrome.style}>
      {tab && (
        <div className="detached-window">
          <div className="detached-bar">
            <span className="detached-title">{tabLabel(tab)}</span>
            {tab.recording && <span className="tab-recording" title={hint('Being recorded')}>REC</span>}
            {tab.broadcast && (
              <span className="tab-broadcast" title={hint('Broadcasting: input also goes to every other tab marked the same way')}>⇶</span>
            )}
            {zoomed !== null && (
              <button
                className="tab-zoom"
                title={hint('Zoom for this tab. Click to reset.')}
                onClick={() => useAppStore.getState().resetZoom(tabId)}
              >
                {zoomed}%
              </button>
            )}
            <span className="detached-spacer" />
            <button
              className="btn-secondary btn-sm"
              title={hint('Put this tab back in the main window. Closing this window does the same.')}
              onClick={() => { void leave(tabId); }}
            >
              Back to main window
            </button>
          </div>
          <TerminalView tab={tab} visible focused />
        </div>
      )}
    </div>
  );
}
