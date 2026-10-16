import { STORED } from '../types';
import type { AuthType, ConnectRequest, ContainerTab, Identity, JumpHopParams, Server } from '../types';

/** How a server's credentials resolve for a connect. */
export interface ResolvedAuth {
  username: string;
  authType: AuthType;
  authValue: string;
}

/**
 * Single source of truth for turning a server (and its identity, if any) into
 * connect credentials. Terminal sessions, SFTP and tunnels all go through this
 * so a new auth mode does not have to be taught to each of them separately.
 *
 * Returns null when nothing usable is configured.
 */
export async function resolveServerAuth(
  server: Server,
  identities: Identity[],
): Promise<ResolvedAuth | null> {
  if (server.identity_id) {
    const identity = identities.find((i) => i.id === server.identity_id);
    if (!identity) return null;
    if (identity.auth_kind === 'keyboard-interactive') {
      // Nothing stored: the server asks and the user answers at connect time.
      return { username: identity.username, authType: 'keyboard-interactive', authValue: '' };
    }
    if (identity.auth_kind === 'agent') {
      // The agent holds the key; authValue optionally pins one by fingerprint.
      return {
        username: identity.username,
        authType: 'agent',
        authValue: identity.agent_fingerprint ?? '',
      };
    }
    if (identity.encrypted_password === STORED) {
      return { username: identity.username, authType: 'identity-password', authValue: identity.id };
    }
    if (identity.key_id) {
      return { username: identity.username, authType: 'key', authValue: identity.key_id };
    }
    return null;
  }

  if (!server.username) return null;

  if (server.auth_kind === 'keyboard-interactive') {
    return { username: server.username, authType: 'keyboard-interactive', authValue: '' };
  }
  if (server.auth_kind === 'agent') {
    return { username: server.username, authType: 'agent', authValue: '' };
  }
  if (server.key_id) {
    return { username: server.username, authType: 'key', authValue: server.key_id };
  }
  if (server.encrypted_password === STORED) {
    return { username: server.username, authType: 'server-password', authValue: server.id };
  }
  return null;
}

/**
 * Matches MAX_HOPS in src-tauri/src/jump.rs. Checked here as well so a loop is
 * caught before any connection is attempted, and named in a message that says
 * which hosts are involved.
 */
const MAX_JUMP_HOPS = 8;

/**
 * Walks a server's chain of jump hosts and resolves each one's credentials.
 *
 * Returns the hops in the order they are connected in: the first is reached
 * over TCP, and each later one through the hop before it. `proxy_jump` points
 * from a server to the host it is reached *through*, so the chain is walked
 * inwards and then reversed.
 *
 * A jump host that has no usable credentials is an error rather than a silent
 * direct connection, which would bypass the bastion the user asked for.
 */
export async function buildJumpChain(
  server: Server,
  servers: Server[],
  identities: Identity[],
): Promise<JumpHopParams[]> {
  const hops: JumpHopParams[] = [];
  const seen = new Set<string>([server.id]);

  let current = server;
  while (current.proxy_jump) {
    const jump = servers.find((s) => s.id === current.proxy_jump);
    if (!jump) {
      throw new Error(`The jump host configured for "${current.name}" no longer exists`);
    }
    if (seen.has(jump.id)) {
      throw new Error(`"${jump.name}" is part of a loop of jump hosts`);
    }
    if (hops.length >= MAX_JUMP_HOPS) {
      throw new Error(`More than ${MAX_JUMP_HOPS} jump hosts chained from "${server.name}"`);
    }
    seen.add(jump.id);

    const resolved = await resolveServerAuth(jump, identities);
    if (!resolved) {
      throw new Error(`No credentials configured for the jump host "${jump.name}"`);
    }
    hops.push({
      host: jump.host,
      port: jump.port,
      username: resolved.username,
      auth_type: resolved.authType,
      auth_value: resolved.authValue,
      server_id: jump.id,
    });
    current = jump;
  }

  return hops.reverse();
}

/** The Containers panel's connection, and whether it is using sudo on the host. */
export interface ContainersConn {
  serverId: string;
  connId: string;
  sudo: boolean;
}

/** A container tab's name: the container and the host, or what it shows. */
export function containerTabName(container: ContainerTab, hostName: string): string {
  return container.kind === 'logs' ? `Logs: ${container.name}` : `${container.name} · ${hostName}`;
}

/** What the backend is told of a container tab: never its name, only what it checks. */
export function containerRequest(container: ContainerTab | undefined): ConnectRequest['container'] {
  return container ? { engine: container.engine, id: container.id, kind: container.kind, sudo: container.sudo } : undefined;
}
