import { describe, expect, it, vi, beforeEach } from 'vitest';
import { STORED } from '../types';
import type { Identity, Server, SessionTab } from '../types';

// The store's credential resolution goes to the keychain for a stored
// password, which is the one thing here that has to cross to Rust. Mocked so
// the rules around it can be tested without a backend, and so a test can see
// exactly which record was asked for.
vi.mock('../ipc', () => ({
  getIdentityPassword: vi.fn(async (id: string) => `identity-secret:${id}`),
  getServerPassword: vi.fn(async (id: string) => `server-secret:${id}`),
  // The strip writes itself down on every change; here there is nowhere to
  // write it to.
  saveOpenTabs: vi.fn(async () => {}),
}));

const { broadcastTargets, buildJumpChain, resolveServerAuth, useAppStore } = await import('./appStore');
const ipc = await import('../ipc');

function server(over: Partial<Server> & { id: string }): Server {
  return {
    name: over.id,
    host: `${over.id}.example.com`,
    port: 22,
    identity_id: null,
    username: 'root',
    encrypted_password: null,
    key_id: null,
    theme: null,
    os: '',
    connection_timeout: null,
    auth_kind: null,
    proxy_jump: null,
    forward_agent: false,
    log_sessions: false,
    group: null,
    run_on_connect: null,
    notes: null,
    ...over,
  };
}

function identity(over: Partial<Identity> & { id: string }): Identity {
  return {
    name: over.id,
    username: 'ident-user',
    key_id: null,
    encrypted_password: null,
    auth_kind: null,
    agent_fingerprint: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('resolveServerAuth', () => {
  it('prefers the identity over anything set on the host itself', async () => {
    const id = identity({ id: 'i1', username: 'via-identity', key_id: 'k1' });
    const s = server({ id: 's1', identity_id: 'i1', username: 'via-host', key_id: 'k2' });

    expect(await resolveServerAuth(s, [id])).toEqual({
      username: 'via-identity',
      authType: 'key',
      authValue: 'k1',
    });
  });

  /**
   * A host pointing at a deleted identity must not quietly fall back to its own
   * credentials: the user moved that host onto an identity, and connecting as
   * whatever was left behind is not what they asked for.
   */
  it('refuses rather than falling back when the identity is gone', async () => {
    const s = server({ id: 's1', identity_id: 'missing', key_id: 'k2' });
    expect(await resolveServerAuth(s, [])).toBeNull();
  });

  it('asks the keychain only when the record says a password is stored', async () => {
    const stored = server({ id: 's1', encrypted_password: STORED });
    expect(await resolveServerAuth(stored, [])).toEqual({
      username: 'root',
      authType: 'password',
      authValue: 'server-secret:s1',
    });
    expect(ipc.getServerPassword).toHaveBeenCalledWith('s1');

    vi.clearAllMocks();
    const none = server({ id: 's2' });
    expect(await resolveServerAuth(none, [])).toBeNull();
    expect(ipc.getServerPassword).not.toHaveBeenCalled();
  });

  it('sends nothing for prompt auth and the fingerprint for an agent', async () => {
    const prompts = identity({ id: 'i1', auth_kind: 'keyboard-interactive' });
    expect(await resolveServerAuth(server({ id: 's1', identity_id: 'i1' }), [prompts]))
      .toEqual({ username: 'ident-user', authType: 'keyboard-interactive', authValue: '' });

    const agent = identity({ id: 'i2', auth_kind: 'agent', agent_fingerprint: 'SHA256:abc' });
    expect(await resolveServerAuth(server({ id: 's2', identity_id: 'i2' }), [agent]))
      .toEqual({ username: 'ident-user', authType: 'agent', authValue: 'SHA256:abc' });
  });

  /**
   * Both auth kinds outrank a stored password, which is the point of the
   * clearing that `save_identity` does: a secret left over from before the
   * change must not be what gets used.
   */
  it('does not reach for a leftover password once an auth kind is set', async () => {
    const id = identity({ id: 'i1', auth_kind: 'agent', encrypted_password: STORED });
    const resolved = await resolveServerAuth(server({ id: 's1', identity_id: 'i1' }), [id]);
    expect(resolved?.authType).toBe('agent');
    expect(ipc.getIdentityPassword).not.toHaveBeenCalled();
  });

  it('has nothing to offer for a host with no username', async () => {
    expect(await resolveServerAuth(server({ id: 's1', username: null }), [])).toBeNull();
  });
});

describe('buildJumpChain', () => {
  it('is empty for a host reached directly', async () => {
    expect(await buildJumpChain(server({ id: 'a' }), [], [])).toEqual([]);
  });

  /**
   * `proxy_jump` points from a host to the one it is reached *through*, so the
   * chain is walked inwards and handed back outermost first: the first hop is
   * the one reached over TCP.
   */
  it('returns the hops in the order they are connected in', async () => {
    const outer = server({ id: 'outer', key_id: 'k' });
    const middle = server({ id: 'middle', key_id: 'k', proxy_jump: 'outer' });
    const target = server({ id: 'target', key_id: 'k', proxy_jump: 'middle' });

    const hops = await buildJumpChain(target, [outer, middle, target], []);
    expect(hops.map((h) => h.host)).toEqual(['outer.example.com', 'middle.example.com']);
    expect(hops[0]).toEqual({
      host: 'outer.example.com',
      port: 22,
      username: 'root',
      auth_type: 'key',
      auth_value: 'k',
    });
  });

  it('names the host whose jump host was deleted', async () => {
    const target = server({ id: 'target', key_id: 'k', proxy_jump: 'gone' });
    await expect(buildJumpChain(target, [target], [])).rejects.toThrow(
      'The jump host configured for "target" no longer exists',
    );
  });

  /**
   * Caught here as well as in Rust so a loop is refused before anything is
   * dialled, and named so the user can see which hosts are involved.
   */
  it('refuses a loop instead of walking it', async () => {
    const a = server({ id: 'a', key_id: 'k', proxy_jump: 'b' });
    const b = server({ id: 'b', key_id: 'k', proxy_jump: 'a' });
    await expect(buildJumpChain(a, [a, b], [])).rejects.toThrow('part of a loop of jump hosts');
  });

  it('stops at the hop limit rather than building an unbounded chain', async () => {
    // Ten hosts, each reached through the next, so the walk would run to ten
    // if nothing stopped it. MAX_HOPS is 8 and matches jump.rs.
    const chain = Array.from({ length: 10 }, (_, i) =>
      server({ id: `h${i}`, key_id: 'k', proxy_jump: i < 9 ? `h${i + 1}` : null }));
    await expect(buildJumpChain(chain[0], chain, [])).rejects.toThrow(
      'More than 8 jump hosts chained from "h0"',
    );
  });

  /**
   * A jump host with no usable credentials has to be an error. Skipping it
   * would connect straight to the target, going around the bastion the user
   * put in the way.
   */
  it('refuses a jump host it cannot authenticate to', async () => {
    const jump = server({ id: 'jump', username: null });
    const target = server({ id: 'target', key_id: 'k', proxy_jump: 'jump' });
    await expect(buildJumpChain(target, [jump, target], [])).rejects.toThrow(
      'No credentials configured for the jump host "jump"',
    );
  });
});

/**
 * A tab is not its session. The tab id is minted when the tab opens and
 * never changes; the session id is whatever backend session is under it now,
 * and is null while there is none. Everything below is what lets a dropped
 * connection reconnect into the same terminal instead of a new tab.
 */
describe('session tabs', () => {
  const tab = (over: Partial<SessionTab> & { tab_id: string }): SessionTab => ({
    session_id: null,
    server_name: over.tab_id,
    server_id: 'srv',
    status: 'connecting',
    ...over,
  });

  beforeEach(() => {
    useAppStore.setState({ sessions: [], activeTabId: 'hosts', sessionThemeOverrides: {} });
  });

  it('keeps the tab id when the session connects', () => {
    useAppStore.getState().addSession(tab({ tab_id: 't1' }));
    useAppStore.getState().updateSessionConnected('t1', 'backend-1');

    const [t] = useAppStore.getState().sessions;
    expect(t.tab_id).toBe('t1');
    expect(t.session_id).toBe('backend-1');
    expect(t.status).toBe('connected');
    expect(useAppStore.getState().activeTabId).toBe('t1');
  });

  it('keeps a dropped tab and forgets only its session', () => {
    useAppStore.getState().addSession(tab({ tab_id: 't1', session_id: 'backend-1', status: 'connected' }));
    useAppStore.getState().markDropped('t1');

    const [t] = useAppStore.getState().sessions;
    expect(t.status).toBe('dropped');
    expect(t.session_id).toBeNull();
    expect(useAppStore.getState().sessions).toHaveLength(1);
  });

  it('binds a new session to the same tab on reconnect', () => {
    useAppStore.getState().addSession(tab({ tab_id: 't1', session_id: 'backend-1', status: 'connected' }));
    useAppStore.getState().markDropped('t1');
    useAppStore.getState().updateSessionConnected('t1', 'backend-2');

    const [t] = useAppStore.getState().sessions;
    expect(t.tab_id).toBe('t1');
    expect(t.session_id).toBe('backend-2');
    expect(t.status).toBe('connected');
    expect(t.reconnecting).toBe(false);
  });

  it('removes by tab id and moves the active tab to the last one left', () => {
    useAppStore.getState().addSession(tab({ tab_id: 't1' }));
    useAppStore.getState().addSession(tab({ tab_id: 't2' }));
    useAppStore.getState().setSessionTheme('t2', 'amoled');
    useAppStore.getState().removeSession('t2');

    expect(useAppStore.getState().sessions.map((t) => t.tab_id)).toEqual(['t1']);
    expect(useAppStore.getState().activeTabId).toBe('t1');
    expect(useAppStore.getState().sessionThemeOverrides).toEqual({});
  });
});

describe('broadcastTargets', () => {
  const tab = (over: Partial<SessionTab> & { tab_id: string }): SessionTab => ({
    session_id: `s-${over.tab_id}`,
    server_name: over.tab_id,
    server_id: 'srv',
    status: 'connected',
    ...over,
  });

  it('is only the tab itself when it is not marked', () => {
    const tabs = [tab({ tab_id: 'a' }), tab({ tab_id: 'b', broadcast: true })];
    expect(broadcastTargets(tabs, 'a')).toEqual(['s-a']);
  });

  it('is every marked, connected tab when it is marked', () => {
    const tabs = [
      tab({ tab_id: 'a', broadcast: true }),
      tab({ tab_id: 'b', broadcast: true }),
      tab({ tab_id: 'c' }),
      tab({ tab_id: 'd', broadcast: true, status: 'dropped', session_id: null }),
    ];
    expect(broadcastTargets(tabs, 'a')).toEqual(['s-a', 's-b']);
  });

  /** A dropped tab has nowhere to send; the terminal uses Enter to reconnect instead. */
  it('sends nowhere from a tab with no session', () => {
    const tabs = [tab({ tab_id: 'a', session_id: null, status: 'dropped' }), tab({ tab_id: 'b', broadcast: true })];
    expect(broadcastTargets(tabs, 'a')).toEqual([]);
    expect(broadcastTargets(tabs, 'nope')).toEqual([]);
  });
});

describe('split panes', () => {
  const tab = (id: string): SessionTab => ({
    tab_id: id, session_id: `s-${id}`, server_name: id, server_id: 'srv', status: 'connected',
  });

  beforeEach(() => {
    useAppStore.setState({ sessions: [tab('a'), tab('b'), tab('c')], activeTabId: 'a', splitGroup: [], sessionThemeOverrides: {} });
  });

  it('starts a group from the anchor and keeps strip order', () => {
    useAppStore.getState().splitWith('b', 'a');
    expect(useAppStore.getState().splitGroup).toEqual(['a', 'b']);
    useAppStore.getState().splitWith('a', 'c');
    expect(useAppStore.getState().splitGroup).toEqual(['a', 'b', 'c']);
  });

  it('ignores a tab dropped on itself, one already in, and one that is not a tab', () => {
    useAppStore.getState().splitWith('a', 'a');
    useAppStore.getState().splitWith('a', 'nope');
    expect(useAppStore.getState().splitGroup).toEqual([]);
    useAppStore.getState().splitWith('a', 'b');
    useAppStore.getState().splitWith('b', 'a');
    expect(useAppStore.getState().splitGroup).toEqual(['a', 'b']);
  });

  /** A pane on its own is a plain tab again, not a split of one. */
  it('dissolves when one member is left, on unsplit and on close', () => {
    useAppStore.getState().splitWith('a', 'b');
    useAppStore.getState().unsplit('a');
    expect(useAppStore.getState().splitGroup).toEqual([]);

    useAppStore.getState().splitWith('a', 'b');
    useAppStore.getState().splitWith('a', 'c');
    useAppStore.getState().removeSession('b');
    expect(useAppStore.getState().splitGroup).toEqual(['a', 'c']);
    useAppStore.getState().removeSession('c');
    expect(useAppStore.getState().splitGroup).toEqual([]);
  });
});
