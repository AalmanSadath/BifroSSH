import type { Identity, PortForwarding, Server, SessionTab } from '../types';

// Records for the store's tests, with every field a real one has. Each takes
// only what a test cares about and fills the rest with something inert.

export function server(over: Partial<Server> & { id: string }): Server {
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
    proxy_command: null,
    forward_agent: false,
    forward_x11: false,
    log_sessions: false,
    group: null,
    run_on_connect: null,
    hide_run_on_connect: true,
    notes: null,
    term: null,
    env: null,
    tags: [],
    ...over,
  };
}

export function identity(over: Partial<Identity> & { id: string }): Identity {
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

export function tab(over: Partial<SessionTab> & { tab_id: string }): SessionTab {
  return {
    session_id: `s-${over.tab_id}`,
    server_name: over.tab_id,
    server_id: 'srv',
    status: 'connected',
    ...over,
  };
}

export function rule(over: Partial<PortForwarding> & { id: string }): PortForwarding {
  return {
    label: over.id,
    type: 'local',
    bind_address: '127.0.0.1',
    local_port: 8080,
    intermediate_host_id: 'srv',
    remote_host_id: null,
    remote_port: null,
    dest_address: 'localhost',
    dest_port: 80,
    autostart_on_launch: false,
    autostart_on_connect: false,
    ...over,
  };
}
