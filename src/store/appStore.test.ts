import { describe, expect, it, vi, beforeEach } from 'vitest';
import { STORED } from '../types';
import type { Identity, Server } from '../types';

// The store's credential resolution goes to the keychain for a stored
// password, which is the one thing here that has to cross to Rust. Mocked so
// the rules around it can be tested without a backend, and so a test can see
// exactly which record was asked for.
vi.mock('../ipc', () => ({
  getIdentityPassword: vi.fn(async (id: string) => `identity-secret:${id}`),
  getServerPassword: vi.fn(async (id: string) => `server-secret:${id}`),
}));

const { buildJumpChain, resolveServerAuth } = await import('./appStore');
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
