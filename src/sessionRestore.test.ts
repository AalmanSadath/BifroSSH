import { describe, expect, it } from 'vitest';
import type { Server, SessionTab } from './types';
import { restoreOrder, tabsToSave } from './sessionRestore';

function tab(over: Partial<SessionTab> & { tab_id: string }): SessionTab {
  return {
    session_id: null,
    server_name: over.tab_id,
    server_id: over.tab_id,
    status: 'connected',
    ...over,
  };
}

function host(id: string): Server {
  return {
    id,
    name: id,
    host: `${id}.example.com`,
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
  };
}

describe('tabsToSave', () => {
  it('keeps saved hosts in strip order, including a host open twice', () => {
    const sessions = [
      tab({ tab_id: 'a', server_id: 's1' }),
      tab({ tab_id: 'b', server_id: 's2' }),
      tab({ tab_id: 'c', server_id: 's1' }),
    ];
    expect(tabsToSave(sessions)).toEqual(['s1', 's2', 's1']);
  });

  it('drops quick connections, which have nothing saved to connect with', () => {
    const sessions = [
      tab({ tab_id: 'a', server_id: 's1' }),
      tab({ tab_id: 'q', server_id: '', quick_info: { host: 'h', port: 22, username: 'root' } }),
    ];
    expect(tabsToSave(sessions)).toEqual(['s1']);
  });

  it('drops a tab that failed, so the failure is not restored with it', () => {
    const sessions = [
      tab({ tab_id: 'a', server_id: 's1', status: 'error', error: 'no auth' }),
      tab({ tab_id: 'b', server_id: 's2', status: 'dropped' }),
    ];
    expect(tabsToSave(sessions)).toEqual(['s2']);
  });
});

describe('restoreOrder', () => {
  it('keeps the recorded order and drops hosts that no longer exist', () => {
    const servers = [host('s1'), host('s2')];
    expect(restoreOrder(['s2', 'gone', 's1', 's2'], servers)).toEqual(['s2', 's1', 's2']);
  });

  it('restores nothing when every recorded host has been deleted', () => {
    expect(restoreOrder(['gone'], [host('s1')])).toEqual([]);
  });
});
