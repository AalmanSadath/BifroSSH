/**
 * Moving a terminal tab into a window of its own, and back.
 *
 * The main window owns every tab, detached or not: its store keeps the tab,
 * its retry loop reconnects it, its broadcast reaches it. A tab's window is a
 * view of one terminal, fed a copy of what it needs to draw it, and sending
 * back what only the main window can act on.
 *
 * The move itself is a handover of the session's output. The side letting go
 * asks the backend to hold the output, waits until it is sure it has written
 * everything sent before the hold, serialises its screen and scrollback, and
 * leaves that for the other side. The side taking over writes the screen,
 * then attaches, which hands it what was held. Nothing printed during the
 * move is lost, and nothing is shown twice.
 */

import { listen } from '@tauri-apps/api/event';
import { SerializeAddon } from '@xterm/addon-serialize';
import type { Terminal } from '@xterm/xterm';
import * as ipc from './ipc';
import { useAppStore, type AppStore } from './store/appStore';
import { stashScreen, terminalFor } from './terminalRegistry';
import { tabLabel } from './tabName';
import type { Mark } from './activity';
import type { NamedTheme } from './styles/themes';
import type { Server, SessionTab, Settings } from './types';

/** What a tab's window is labelled; the backend builds the same from the tab id. */
export const DETACHED_PREFIX = 'term-';

export const windowLabel = (tabId: string) => `${DETACHED_PREFIX}${tabId}`;

/** The tab a window is showing, from its label, or null for the main window. */
export function detachedTabId(label: string): string | null {
  return label.startsWith(DETACHED_PREFIX) ? label.slice(DETACHED_PREFIX.length) : null;
}

/** What a tab's window draws from, sent when it opens and again when any of it changes. */
export interface Mirror {
  tab: SessionTab;
  settings: Settings;
  servers: Server[];
  customThemes: Record<string, NamedTheme>;
  themeOverride?: string;
}

/** What a new tab window collects when it opens. */
export interface Opening extends Mirror {
  screen: string;
  zoom?: number;
}

/** Why a tab came back other than by being asked to. */
export type Ended = { kind: 'dropped'; endedWith?: number } | { kind: 'exited' };

/** What a closing tab window leaves for the main window. */
export interface Returned {
  screen: string;
  zoom?: number;
  ended?: Ended;
}

/** What a tab's window asks the main window to do, because only it can. */
export type DetachedAction =
  | { action: 'sendInput'; tabId: string; bytes: number[] }
  | { action: 'learnCommand'; serverId: string; command: string }
  | { action: 'openInSftp'; serverId: string; path: string }
  | { action: 'markActivity'; tabId: string; mark: Mark };

export function mirrorOf(s: Pick<AppStore, 'settings' | 'servers' | 'customThemes' | 'sessionThemeOverrides'>, tab: SessionTab): Mirror {
  return {
    tab,
    settings: s.settings,
    servers: s.servers,
    customThemes: s.customThemes,
    themeOverride: s.sessionThemeOverrides[tab.tab_id],
  };
}

/** Parses what one window left for another, or null when nothing usable was. */
export function parsePayload<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

const HOLD_WAIT_MS = 2_000;

/**
 * Stops the session's output reaching this window, and resolves once
 * everything sent before that has arrived. The backend's `ssh-held` event
 * goes out after every output event sent before the hold, so by the time it
 * is heard the terminal's listener has had all of them. The wait is bounded:
 * should the event go astray, a move that loses a few bytes beats one that
 * never happens.
 */
export async function holdOutput(sessionId: string): Promise<void> {
  let heard!: () => void;
  const held = new Promise<void>((resolve) => { heard = resolve; });
  // Listening before asking, so the answer cannot arrive first.
  const unlisten = await listen(`ssh-held:${sessionId}`, () => heard());
  try {
    if (await ipc.sshHold(sessionId)) {
      await Promise.race([held, new Promise<void>((resolve) => setTimeout(resolve, HOLD_WAIT_MS))]);
    }
  } finally {
    unlisten();
  }
}

/** The terminal's screen and scrollback, colours included, once every write so far has landed. */
export async function screenOf(term: Terminal): Promise<string> {
  await new Promise<void>((resolve) => term.write('', resolve));
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  try {
    return serializer.serialize();
  } finally {
    serializer.dispose();
  }
}

const decode = (payload: string) => Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));

/**
 * Moves a connected tab into a window of its own. Throws with the reason when
 * it could not, having given the output back to the terminal here.
 */
export async function detachTab(tabId: string): Promise<void> {
  const st = useAppStore.getState();
  const tab = st.sessions.find((t) => t.tab_id === tabId);
  if (!tab || tab.detached || tab.status !== 'connected' || !tab.session_id) return;
  const sessionId = tab.session_id;

  await holdOutput(sessionId);
  const term = terminalFor(tabId);
  const opening: Opening = {
    ...mirrorOf(st, tab),
    screen: term ? await screenOf(term) : '',
    zoom: st.sessionZoom[tabId],
  };
  try {
    await ipc.windowDetach(tabId, tabLabel(tab), JSON.stringify(opening));
  } catch (e) {
    // Nothing moved. The terminal here is still listening; what was held
    // while trying is written to it, and the session goes back to live.
    const pending = await ipc.sshAttach(sessionId).catch(() => '');
    if (pending && term) term.write(decode(pending));
    throw e;
  }
  useAppStore.getState().setDetached(tabId, true);
}

/**
 * A tab's window has gone: the tab comes back here with whatever the window
 * left. A window that went without leaving anything, a crash, still gives its
 * tab back, without the scrollback it had drawn since leaving.
 */
export async function takeBack(tabId: string): Promise<void> {
  const tab = useAppStore.getState().sessions.find((t) => t.tab_id === tabId);
  if (!tab?.detached) return;
  const back = parsePayload<Returned>(await ipc.windowTake(tabId).catch(() => null));

  const st = useAppStore.getState();
  if (back?.ended?.kind === 'exited') {
    st.removeSession(tabId);
    return;
  }
  if (back?.screen) stashScreen(tabId, back.screen);
  if (back) {
    useAppStore.setState((s) => {
      const { [tabId]: _old, ...rest } = s.sessionZoom;
      return { sessionZoom: back.zoom === undefined ? rest : { ...rest, [tabId]: back.zoom } };
    });
  }
  // Dropped before the terminal comes back, so it mounts with no session to
  // bind to and the retry loop, which only runs here, takes it from there.
  if (back?.ended?.kind === 'dropped') st.markDropped(tabId, back.ended.endedWith);
  st.setDetached(tabId, false);
}

/** Does here what a tab's window asked for. Anything not on this list is ignored. */
export function runDetachedAction(a: DetachedAction): void {
  const st = useAppStore.getState();
  switch (a.action) {
    case 'sendInput':
      st.sendInput(a.tabId, a.bytes);
      return;
    case 'learnCommand':
      st.learnCommand(a.serverId, a.command);
      return;
    case 'openInSftp':
      st.openInSftp(a.serverId, a.path);
      return;
    case 'markActivity':
      st.markActivity(a.tabId, a.mark);
      return;
  }
}
