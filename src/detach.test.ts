import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tab } from './store/fixtures';

// What a closing tab window left behind, as the backend would hand it over.
let left: string | null = null;

vi.mock('./ipc', () => ({
  saveOpenTabs: vi.fn(async () => {}),
  sshSendInput: vi.fn(async () => {}),
  recordCommands: vi.fn(async () => {}),
  windowTake: vi.fn(async () => { const v = left; left = null; return v; }),
}));

const { useAppStore } = await import('./store/appStore');
const { detachedTabId, parsePayload, runDetachedAction, takeBack, windowLabel } = await import('./detach');
const { takeScreen } = await import('./terminalRegistry');
const ipc = vi.mocked(await import('./ipc'));

const initial = useAppStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  left = null;
  useAppStore.setState(initial, true);
});

describe('window labels', () => {
  it('names a tab window after its tab, and reads the tab back', () => {
    expect(windowLabel('abc-1')).toBe('term-abc-1');
    expect(detachedTabId('term-abc-1')).toBe('abc-1');
    expect(detachedTabId('main')).toBeNull();
  });

  it('treats a payload it cannot read as none', () => {
    expect(parsePayload(null)).toBeNull();
    expect(parsePayload('{not json')).toBeNull();
    expect(parsePayload<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
  });
});

describe('the store', () => {
  it('takes a tab going out of its split', () => {
    useAppStore.setState({ sessions: [tab({ tab_id: 'a' }), tab({ tab_id: 'b' }), tab({ tab_id: 'c' })], splitGroup: ['a', 'b', 'c'], splitWidths: [30, 30, 40] });
    useAppStore.getState().setDetached('b', true);

    const s = useAppStore.getState();
    expect(s.sessions.find((t) => t.tab_id === 'b')?.detached).toBe(true);
    expect(s.splitGroup).toEqual(['a', 'c']);
    expect(s.splitWidths).toEqual([]);

    useAppStore.getState().setDetached('b', false);
    expect(useAppStore.getState().sessions.find((t) => t.tab_id === 'b')?.detached).toBeUndefined();
  });

  it('will not split with a tab that is in its own window', () => {
    useAppStore.setState({ sessions: [tab({ tab_id: 'a' }), tab({ tab_id: 'b', detached: true })], activeTabId: 'a' });
    useAppStore.getState().splitWith('a', 'b');
    expect(useAppStore.getState().splitGroup).toEqual([]);
  });
});

describe('taking a tab back', () => {
  beforeEach(() => {
    useAppStore.setState({
      sessions: [tab({ tab_id: 't', session_id: 's1', detached: true })],
      sessionZoom: { t: 18 },
      settings: { ...initial.settings, auto_reconnect: false },
    });
  });

  it('comes back with the screen and zoom the window left', async () => {
    left = JSON.stringify({ screen: 'scrollback', zoom: 12 });
    await takeBack('t');

    const s = useAppStore.getState();
    expect(s.sessions[0]).toMatchObject({ session_id: 's1', status: 'connected' });
    expect(s.sessions[0].detached).toBeUndefined();
    expect(s.sessionZoom).toEqual({ t: 12 });
    expect(takeScreen('t')).toBe('scrollback');
  });

  it('follows a zoom that was reset over there', async () => {
    left = JSON.stringify({ screen: '' });
    await takeBack('t');
    expect(useAppStore.getState().sessionZoom).toEqual({});
  });

  it('comes back dropped when the connection went while it was out', async () => {
    left = JSON.stringify({ screen: '[Connection lost]', ended: { kind: 'dropped' } });
    await takeBack('t');
    expect(useAppStore.getState().sessions[0]).toMatchObject({ status: 'dropped', session_id: null });
    expect(useAppStore.getState().sessions[0].detached).toBeUndefined();
  });

  it('closes when its shell exited', async () => {
    left = JSON.stringify({ screen: '', ended: { kind: 'exited' } });
    await takeBack('t');
    expect(useAppStore.getState().sessions).toEqual([]);
  });

  it('still comes back from a window that left nothing', async () => {
    await takeBack('t');
    const s = useAppStore.getState();
    expect(s.sessions[0].detached).toBeUndefined();
    expect(s.sessionZoom).toEqual({ t: 18 });
  });

  it('ignores a tab that is not out, or not there', async () => {
    useAppStore.setState({ sessions: [tab({ tab_id: 't' })] });
    await takeBack('t');
    await takeBack('gone');
    expect(ipc.windowTake).not.toHaveBeenCalled();
  });
});

describe('what a tab window asks for', () => {
  it('broadcasts from the main window, which knows the other tabs', () => {
    useAppStore.setState({
      sessions: [tab({ tab_id: 'a', broadcast: true, detached: true }), tab({ tab_id: 'b', broadcast: true })],
    });
    runDetachedAction({ action: 'sendInput', tabId: 'a', bytes: [104, 105] });
    expect(ipc.sshSendInput.mock.calls.map(([sid]) => sid)).toEqual(['s-a', 's-b']);
  });

  it('opens SFTP and learns commands here', () => {
    runDetachedAction({ action: 'openInSftp', serverId: 'srv', path: '/var/log' });
    expect(useAppStore.getState()).toMatchObject({ activeTabId: 'sftp', sftpRequest: { serverId: 'srv', path: '/var/log' } });

    runDetachedAction({ action: 'learnCommand', serverId: 'srv', command: 'uptime' });
    expect(useAppStore.getState().commandHistory.srv).toEqual(['uptime']);
  });
});
