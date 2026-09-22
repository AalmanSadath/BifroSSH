import { describe, expect, it } from 'vitest';
import type { Server } from './types';
import { UNGROUPED, groupNames, hostSections, matchesHost } from './hosts';

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
    ...over,
  };
}

const names = (sections: ReturnType<typeof hostSections>) =>
  sections.map((s) => [s.group, s.servers.map((h) => h.id)]);

const hosts = [
  server({ id: 'web2', group: 'prod' }),
  server({ id: 'web1', group: 'prod' }),
  server({ id: 'db', group: 'staging', username: 'postgres' }),
  server({ id: 'pi', host: '10.0.0.7' }),
  server({ id: 'nas', group: '  ' }),
];

describe('groupNames', () => {
  it('lists each group once, in name order, and treats blank as none', () => {
    expect(groupNames(hosts)).toEqual(['prod', 'staging']);
  });
});

describe('matchesHost', () => {
  it('looks at the name, address, user and group, case-insensitively', () => {
    const db = hosts[2];
    expect(matchesHost(db, 'DB')).toBe(true);
    expect(matchesHost(db, 'example')).toBe(true);
    expect(matchesHost(db, 'postgres')).toBe(true);
    expect(matchesHost(db, 'stag')).toBe(true);
    expect(matchesHost(db, 'prod')).toBe(false);
  });

  it('matches everything on a blank query', () => {
    expect(matchesHost(hosts[3], '   ')).toBe(true);
  });
});

describe('hostSections', () => {
  it('sections by group in name order, hosts in name order, ungrouped last', () => {
    expect(names(hostSections(hosts, '', null))).toEqual([
      ['prod', ['web1', 'web2']],
      ['staging', ['db']],
      [null, ['nas', 'pi']],
    ]);
  });

  it('keeps one group when a chip is chosen', () => {
    expect(names(hostSections(hosts, '', 'prod'))).toEqual([['prod', ['web1', 'web2']]]);
    expect(names(hostSections(hosts, '', UNGROUPED))).toEqual([[null, ['nas', 'pi']]]);
  });

  it('drops sections the query empties', () => {
    expect(names(hostSections(hosts, '10.0', null))).toEqual([[null, ['pi']]]);
    expect(hostSections(hosts, 'nothing here', null)).toEqual([]);
  });

  it('is one nameless section when no host has a group', () => {
    const plain = [server({ id: 'b' }), server({ id: 'a' })];
    expect(names(hostSections(plain, '', null))).toEqual([[null, ['a', 'b']]]);
  });
});
