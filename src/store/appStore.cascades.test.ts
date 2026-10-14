import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { identity, rule, server, tab } from './fixtures';

// What the store does to the rest of itself when one thing changes: a delete
// that has to reach the lists holding references to what went, a drop that
// starts a retry, a load that fans out into everything else. Every backend
// call is mocked, so each test can say what the backend answers and see what
// the store asked of it.
vi.mock('../ipc', () => ({
  saveOpenTabs: vi.fn(async () => {}),
  recordCommands: vi.fn(async () => {}),
  getCommandHistory: vi.fn(async () => []),
  clearCommandHistory: vi.fn(async () => {}),
  deleteServer: vi.fn(async () => {}),
  deleteServers: vi.fn(async () => {}),
  listServers: vi.fn(async () => []),
  deleteIdentity: vi.fn(async () => {}),
  listIdentities: vi.fn(async () => []),
  listKeys: vi.fn(async () => []),
  getSettings: vi.fn(),
  getPortForwardings: vi.fn(async () => []),
  getCodeprints: vi.fn(async () => []),
  getCustomThemes: vi.fn(async () => ({})),
  getSftpBookmarks: vi.fn(async () => []),
  getOpenTabs: vi.fn(async () => []),
  savePortForwardings: vi.fn(async () => {}),
  saveCodeprints: vi.fn(async () => {}),
  saveCustomThemes: vi.fn(async () => {}),
  saveSftpBookmarks: vi.fn(async () => {}),
  saveSettings: vi.fn(async () => {}),
  sshConnect: vi.fn(),
  sshSetLog: vi.fn(async () => {}),
  sshSetRecording: vi.fn(async () => null),
  tunnelStart: vi.fn(async () => {}),
  tunnelStop: vi.fn(async () => {}),
  probeHost: vi.fn(),
}));

vi.mock('@tauri-apps/api/app', () => ({ getVersion: vi.fn(async () => '0.16.0') }));
vi.mock('../updates', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../updates')>()),
  fetchLatestRelease: vi.fn(async () => null),
}));
vi.mock('../terminalRegistry', () => ({ terminalFor: vi.fn(() => undefined) }));

const { useAppStore } = await import('./appStore');
const ipc = vi.mocked(await import('../ipc'));
const updates = vi.mocked(await import('../updates'));

const initial = useAppStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useAppStore.setState(initial, true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('clearForLock', () => {
  it('drops every copy of vault data and keeps what the lock screen needs', () => {
    const settings = { ...initial.settings, font_size: 18 };
    useAppStore.setState({
      servers: [server({ id: 'a' })],
      identities: [identity({ id: 'i' })],
      keys: [{ id: 'k' } as never],
      portForwardings: [rule({ id: 'pf' })],
      codeprints: [{ id: 'c', name: 'c', content: 'ls' } as never],
      retryingTabIds: new Set(['t1']),
      hostProbes: { a: 'running' },
      settings,
      sessions: [tab({ tab_id: 't1' })],
    });

    useAppStore.getState().clearForLock();

    const s = useAppStore.getState();
    expect(s.servers).toEqual([]);
    expect(s.identities).toEqual([]);
    expect(s.keys).toEqual([]);
    expect(s.portForwardings).toEqual([]);
    expect(s.codeprints).toEqual([]);
    expect(s.retryingTabIds.size).toBe(0);
    expect(s.hostProbes).toEqual({});
    expect(s.settings).toBe(settings);
    expect(s.sessions.map((t) => t.tab_id)).toEqual(['t1']);
  });
});

describe('deleting hosts and identities', () => {
  it('takes bookmarks, history and unsaved commands with the hosts', async () => {
    vi.useFakeTimers();
    ipc.listServers.mockResolvedValueOnce([server({ id: 'b' })]);
    useAppStore.setState({
      servers: [server({ id: 'a' }), server({ id: 'b' })],
      sftpBookmarks: [
        { id: '1', server_id: 'a', label: 'a', path: '/a' },
        { id: '2', server_id: 'b', label: 'b', path: '/b' },
        { id: '3', server_id: null, label: 'local', path: '/tmp' },
      ],
      commandHistory: { a: ['ls'], b: ['pwd'] },
    });
    useAppStore.getState().learnCommand('a', 'uptime');
    useAppStore.getState().learnCommand('b', 'whoami');

    await useAppStore.getState().deleteServers(['a']);
    await vi.advanceTimersByTimeAsync(5_000);

    const s = useAppStore.getState();
    expect(ipc.deleteServer).toHaveBeenCalledWith('a');
    expect(ipc.deleteServers).not.toHaveBeenCalled();
    expect(s.servers.map((x) => x.id)).toEqual(['b']);
    expect(s.sftpBookmarks.map((b) => b.id)).toEqual(['2', '3']);
    expect(Object.keys(s.commandHistory)).toEqual(['b']);
    expect(ipc.recordCommands).toHaveBeenCalledTimes(1);
    expect(ipc.recordCommands).toHaveBeenCalledWith('b', ['whoami']);
  });

  it('deletes several in one call', async () => {
    await useAppStore.getState().deleteServers(['a', 'b']);
    expect(ipc.deleteServers).toHaveBeenCalledWith(['a', 'b']);
    expect(ipc.deleteServer).not.toHaveBeenCalled();
  });

  it('unsets a deleted identity on the hosts that used it', async () => {
    useAppStore.setState({
      identities: [identity({ id: 'i1' }), identity({ id: 'i2' })],
      servers: [server({ id: 'a', identity_id: 'i1' }), server({ id: 'b', identity_id: 'i2' })],
    });

    await useAppStore.getState().deleteIdentity('i1');

    const s = useAppStore.getState();
    expect(s.identities.map((i) => i.id)).toEqual(['i2']);
    expect(s.servers.map((x) => x.identity_id)).toEqual([null, 'i2']);
  });
});

describe('removeSession', () => {
  it('forgets everything kept per tab', () => {
    useAppStore.setState({
      sessions: [tab({ tab_id: 'a' }), tab({ tab_id: 'b' }), tab({ tab_id: 'c' })],
      activeTabId: 'b',
      sessionThemeOverrides: { a: 'x', b: 'y' },
      sessionZoom: { a: 12, b: 16 },
      sessionActivity: { b: { state: 'running', since: 1 } as never },
      splitGroup: ['a', 'b', 'c'],
      splitWidths: [30, 30, 40],
      retryingTabIds: new Set(['b']),
    });

    useAppStore.getState().removeSession('b');

    const s = useAppStore.getState();
    expect(s.sessions.map((t) => t.tab_id)).toEqual(['a', 'c']);
    expect(s.activeTabId).toBe('c');
    expect(s.sessionThemeOverrides).toEqual({ a: 'x' });
    expect(s.sessionZoom).toEqual({ a: 12 });
    expect(s.sessionActivity).toEqual({});
    expect(s.splitGroup).toEqual(['a', 'c']);
    expect(s.splitWidths).toEqual([]);
    expect(s.retryingTabIds.has('b')).toBe(false);
    expect(ipc.saveOpenTabs).toHaveBeenCalled();
  });

  it('goes back to the hosts page when the last tab closes', () => {
    useAppStore.setState({ sessions: [tab({ tab_id: 'a' })], activeTabId: 'a' });
    useAppStore.getState().removeSession('a');
    expect(useAppStore.getState().activeTabId).toBe('hosts');
  });
});

describe('dropped tabs and the retry loop', () => {
  const host = server({ id: 'srv', key_id: 'k' });

  beforeEach(() => {
    vi.useFakeTimers();
    useAppStore.setState({
      servers: [host],
      sessions: [tab({ tab_id: 't1' })],
      sessionActivity: { t1: { state: 'running', since: 1 } as never },
    });
  });

  const settings = (over: Partial<typeof initial.settings>) =>
    useAppStore.setState({ settings: { ...initial.settings, ...over } });

  it('does not retry when the setting is off', () => {
    settings({ auto_reconnect: false });
    useAppStore.getState().markDropped('t1');

    const s = useAppStore.getState();
    expect(s.sessions[0].status).toBe('dropped');
    expect(s.sessionActivity).toEqual({});
    expect(s.retryingTabIds.size).toBe(0);
  });

  it('does not retry a command that ended, or a quick connection', () => {
    settings({ auto_reconnect: true });
    useAppStore.getState().markDropped('t1', 1);
    expect(useAppStore.getState().retryingTabIds.size).toBe(0);

    useAppStore.setState({ sessions: [tab({ tab_id: 't2', quick_info: { host: 'h', port: 22, username: 'u' } })] });
    useAppStore.getState().markDropped('t2');
    expect(useAppStore.getState().retryingTabIds.size).toBe(0);
  });

  it('reconnects into the same tab and stops', async () => {
    settings({ auto_reconnect: true, auto_reconnect_attempts: 5 });
    ipc.sshConnect.mockResolvedValueOnce('backend-2');

    useAppStore.getState().markDropped('t1');
    expect(useAppStore.getState().retryingTabIds.has('t1')).toBe(true);
    expect(useAppStore.getState().sessions[0].retryAt).toBeDefined();

    await vi.advanceTimersByTimeAsync(5_000);

    const s = useAppStore.getState();
    expect(s.sessions[0]).toMatchObject({ status: 'connected', session_id: 'backend-2' });
    expect(s.sessions[0].retryAt).toBeUndefined();
    expect(s.retryingTabIds.size).toBe(0);
  });

  it('backs off and gives up at the attempt limit', async () => {
    settings({ auto_reconnect: true, auto_reconnect_attempts: 2 });
    ipc.sshConnect.mockRejectedValue(new Error('refused'));

    useAppStore.getState().markDropped('t1');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ipc.sshConnect).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().sessions[0].retryAttempt).toBe(2);

    // The second wait is twice the first.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(ipc.sshConnect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(ipc.sshConnect).toHaveBeenCalledTimes(2);

    const s = useAppStore.getState();
    expect(s.sessions[0]).toMatchObject({ status: 'dropped', gaveUpAfter: 2, error: 'Error: refused' });
    expect(s.retryingTabIds.size).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(ipc.sshConnect).toHaveBeenCalledTimes(2);
  });

  it('stops when the tab is closed while waiting', async () => {
    settings({ auto_reconnect: true });
    useAppStore.getState().markDropped('t1');
    useAppStore.getState().removeSession('t1');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ipc.sshConnect).not.toHaveBeenCalled();
  });
});

describe('tunnels', () => {
  const host = server({ id: 'srv', key_id: 'k' });

  beforeEach(() => {
    useAppStore.setState({ servers: [host] });
  });

  it('starts only the rules the trigger is for', async () => {
    useAppStore.setState({
      portForwardings: [
        rule({ id: 'launch', autostart_on_launch: true }),
        rule({ id: 'running', autostart_on_launch: true }),
        rule({ id: 'connect', autostart_on_connect: true }),
        rule({ id: 'other-host', autostart_on_connect: true, intermediate_host_id: 'elsewhere' }),
        rule({ id: 'manual' }),
      ],
      activeTunnelIds: new Set(['running']),
    });

    await useAppStore.getState().autostartTunnels({ kind: 'launch' });
    expect(ipc.tunnelStart.mock.calls.map(([p]) => p.pfId)).toEqual(['launch']);

    ipc.tunnelStart.mockClear();
    await useAppStore.getState().autostartTunnels({ kind: 'connect', serverId: 'srv' });
    expect(ipc.tunnelStart.mock.calls.map(([p]) => p.pfId)).toEqual(['connect']);
    expect(useAppStore.getState().activeTunnelIds).toEqual(new Set(['running', 'launch', 'connect']));
  });

  it('gathers every failure into one banner', async () => {
    useAppStore.setState({
      portForwardings: [
        rule({ id: 'a', label: 'A', autostart_on_launch: true }),
        rule({ id: 'b', label: 'B', autostart_on_launch: true, intermediate_host_id: 'gone' }),
        rule({ id: 'c', label: 'C', autostart_on_launch: true }),
      ],
    });
    ipc.tunnelStart.mockRejectedValueOnce(new Error('port in use'));

    await useAppStore.getState().autostartTunnels({ kind: 'launch' });

    expect(useAppStore.getState().actionError).toBe(
      'Could not start some tunnels. A: Error: port in use · B: Error: Server not found',
    );
    expect(useAppStore.getState().activeTunnelIds).toEqual(new Set(['c']));
  });

  it('lets a manual rule go quiet when it drops', () => {
    useAppStore.setState({ portForwardings: [rule({ id: 'm' })], activeTunnelIds: new Set(['m']) });
    useAppStore.getState().tunnelDropped('m');
    const s = useAppStore.getState();
    expect(s.activeTunnelIds.size).toBe(0);
    expect(s.retryingTunnelIds.size).toBe(0);
    expect(s.actionError).toBeNull();
  });

  it('brings an autostart rule back with backoff', async () => {
    vi.useFakeTimers();
    useAppStore.setState({
      portForwardings: [rule({ id: 'a', label: 'A', autostart_on_launch: true })],
      activeTunnelIds: new Set(['a']),
    });
    ipc.tunnelStart.mockRejectedValueOnce(new Error('down'));

    useAppStore.getState().tunnelDropped('a');
    expect(useAppStore.getState().actionError).toBe('Tunnel "A" dropped. Trying again.');
    expect(useAppStore.getState().retryingTunnelIds.has('a')).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(ipc.tunnelStart).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(ipc.tunnelStart).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(ipc.tunnelStart).toHaveBeenCalledTimes(2);

    const s = useAppStore.getState();
    expect(s.retryingTunnelIds.size).toBe(0);
    expect(s.activeTunnelIds.has('a')).toBe(true);
  });

  it('stops retrying a rule the user stopped', async () => {
    vi.useFakeTimers();
    useAppStore.setState({ portForwardings: [rule({ id: 'a', autostart_on_launch: true })] });
    useAppStore.getState().tunnelDropped('a');
    await useAppStore.getState().stopTunnel('a');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ipc.tunnelStart).not.toHaveBeenCalled();
  });
});

describe('loadAll', () => {
  beforeEach(() => {
    ipc.getSettings.mockResolvedValue({ ...initial.settings, check_for_updates: false, restore_tabs: false });
  });

  it('fills every list and carries old localStorage data across once', async () => {
    ipc.listServers.mockResolvedValueOnce([server({ id: 'a' })]);
    ipc.getPortForwardings.mockResolvedValueOnce([rule({ id: 'kept' })]);
    const legacyCodeprints = [{ id: 'c', name: 'c', content: 'ls' }];
    localStorage.setItem('bifrossh_codeprints', JSON.stringify(legacyCodeprints));
    localStorage.setItem('bifrossh_port_forwardings', JSON.stringify([rule({ id: 'old' })]));

    await useAppStore.getState().loadAll();

    const s = useAppStore.getState();
    expect(s.loadError).toBeNull();
    expect(s.servers.map((x) => x.id)).toEqual(['a']);
    expect(s.codeprints).toEqual(legacyCodeprints);
    expect(ipc.saveCodeprints).toHaveBeenCalledWith(legacyCodeprints);
    expect(localStorage.getItem('bifrossh_codeprints')).toBeNull();
    // The store already had rules, so the old ones are neither written over
    // them nor thrown away.
    expect(s.portForwardings.map((p) => p.id)).toEqual(['kept']);
    expect(ipc.savePortForwardings).not.toHaveBeenCalled();
    expect(localStorage.getItem('bifrossh_port_forwardings')).not.toBeNull();
  });

  it('says so when a read fails, rather than showing empty lists', async () => {
    ipc.listKeys.mockRejectedValueOnce('vault unreadable');

    await useAppStore.getState().loadAll();

    const s = useAppStore.getState();
    expect(s.loadError).toBe('vault unreadable');
    expect(s.recentErrors[s.recentErrors.length - 1]).toMatchObject({ where: 'loading saved data', message: 'vault unreadable' });
  });
});

describe('command history', () => {
  it('keeps what was learned while the saved list was loading, in front', async () => {
    let answer!: (v: string[]) => void;
    ipc.getCommandHistory.mockReturnValueOnce(new Promise((r) => { answer = r; }));

    const loading = useAppStore.getState().loadCommandHistory('srv');
    useAppStore.getState().learnCommand('srv', 'new');
    answer(['old', 'new', 'older']);
    await loading;

    expect(useAppStore.getState().commandHistory.srv).toEqual(['new', 'old', 'older']);
  });

  it('loads a host once', async () => {
    useAppStore.setState({ commandHistory: { srv: ['ls'] } });
    await useAppStore.getState().loadCommandHistory('srv');
    expect(ipc.getCommandHistory).not.toHaveBeenCalled();
  });
});

describe('probeHosts', () => {
  it('dials direct hosts with their own timeout and skips the rest', async () => {
    useAppStore.setState({
      settings: { ...initial.settings, connection_timeout_secs: 30 },
      servers: [
        server({ id: 'a' }),
        server({ id: 'b', connection_timeout: 5 }),
        server({ id: 'jumped', proxy_jump: 'a' }),
        server({ id: 'down' }),
      ],
    });
    ipc.probeHost.mockImplementation(async (host: string) => {
      if (host === 'down.example.com') throw 'timed out';
      return { reachable: true, ms: 3, error: null };
    });

    await useAppStore.getState().probeHosts(['a', 'b', 'jumped', 'down']);

    expect(ipc.probeHost).toHaveBeenCalledWith('a.example.com', 22, 30);
    expect(ipc.probeHost).toHaveBeenCalledWith('b.example.com', 22, 5);
    const probes = useAppStore.getState().hostProbes;
    expect(probes.jumped).toBe('skipped');
    expect(probes.a).toMatchObject({ reachable: true, ms: 3 });
    expect(probes.down).toMatchObject({ reachable: false, error: 'timed out' });
  });

  it('leaves a fresh result alone unless asked by hand', async () => {
    useAppStore.setState({
      servers: [server({ id: 'a' })],
      hostProbes: { a: { reachable: true, ms: 1, error: null, at: Date.now() } },
    });
    ipc.probeHost.mockResolvedValue({ reachable: true, ms: 2, error: null });

    await useAppStore.getState().probeHosts(['a']);
    expect(ipc.probeHost).not.toHaveBeenCalled();
    await useAppStore.getState().probeHosts(['a'], true);
    expect(ipc.probeHost).toHaveBeenCalledTimes(1);
  });
});

describe('checkForUpdates', () => {
  it('does nothing at launch when turned off', async () => {
    useAppStore.setState({ settings: { ...initial.settings, check_for_updates: false } });
    expect(await useAppStore.getState().checkForUpdates()).toBe(false);
    expect(updates.fetchLatestRelease).not.toHaveBeenCalled();
  });

  it('checks when asked even if turned off, and stamps the time', async () => {
    useAppStore.setState({ settings: { ...initial.settings, check_for_updates: false, last_update_check: 0 } });
    updates.fetchLatestRelease.mockResolvedValueOnce({ version: '0.17.0', url: 'https://example.com' });

    expect(await useAppStore.getState().checkForUpdates(true)).toBe(true);

    const s = useAppStore.getState();
    expect(s.updateAvailable).toEqual({ version: '0.17.0', url: 'https://example.com' });
    expect(s.settings.last_update_check).toBeGreaterThan(0);
    expect(ipc.saveSettings).toHaveBeenCalledTimes(1);
  });

  it('announces nothing when this build is the latest', async () => {
    updates.fetchLatestRelease.mockResolvedValueOnce({ version: '0.16.0', url: 'https://example.com' });
    await useAppStore.getState().checkForUpdates(true);
    expect(useAppStore.getState().updateAvailable).toBeNull();
  });
});

describe('SFTP bookmarks', () => {
  it('keeps one bookmark per directory and host', () => {
    const add = useAppStore.getState().addBookmark;
    add({ server_id: 'a', label: 'logs', path: '/var/log' });
    add({ server_id: 'a', label: 'again', path: '/var/log' });
    add({ server_id: 'b', label: 'logs', path: '/var/log' });
    add({ server_id: null, label: 'tmp', path: '/tmp' });
    add({ server_id: null, label: 'tmp', path: '/tmp' });

    const marks = useAppStore.getState().sftpBookmarks;
    expect(marks.map((b) => [b.server_id, b.path])).toEqual([['a', '/var/log'], ['b', '/var/log'], [null, '/tmp']]);
    expect(ipc.saveSftpBookmarks).toHaveBeenCalledTimes(3);

    useAppStore.getState().deleteBookmark(marks[0].id);
    expect(useAppStore.getState().sftpBookmarks).toHaveLength(2);
  });
});
