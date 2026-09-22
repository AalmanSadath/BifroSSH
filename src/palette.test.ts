import { describe, expect, it } from 'vitest';
import { bySection, rankCommands, score, type Command } from './palette';

const cmd = (title: string, over: Partial<Command> = {}): Command =>
  ({ id: title, title, group: 'Hosts', run: () => {}, ...over });

describe('score', () => {
  it('matches letters in order, not necessarily together', () => {
    expect(score('prod-db', 'prdb')).not.toBeNull();
    expect(score('prod-db', 'bdrp')).toBeNull();
    expect(score('prod-db', '')).toBe(0);
  });

  it('prefers a prefix, then a word start, then the middle', () => {
    const prefix = score('db-main', 'db')!;
    const word = score('main-db', 'db')!;
    const middle = score('adbx', 'db')!;
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(middle);
  });

  it('prefers the shorter of two names that match the same way', () => {
    expect(score('db', 'db')!).toBeGreaterThan(score('database-replica', 'db')!);
  });

  it('ignores case on both sides', () => {
    expect(score('Prod Web', 'pw')).toEqual(score('prod web', 'PW'));
  });
});

describe('rankCommands', () => {
  it('returns everything, in order, for an empty query', () => {
    const all = [cmd('b'), cmd('a')];
    expect(rankCommands(all, '  ')).toEqual(all);
  });

  it('drops what does not match and puts the best first', () => {
    const ranked = rankCommands([cmd('database-replica'), cmd('nothing'), cmd('db')], 'db');
    expect(ranked.map((c) => c.title)).toEqual(['db', 'database-replica']);
  });

  it('matches a subtitle, but ranks it under a title hit', () => {
    const ranked = rankCommands([
      cmd('web', { subtitle: 'root@10.0.0.5:22' }),
      cmd('tenten', { subtitle: 'nothing here' }),
    ], '10.0');
    expect(ranked.map((c) => c.title)).toEqual(['web']);
  });
});

describe('bySection', () => {
  it('groups in display order and drops the empty ones', () => {
    const sections = bySection([
      cmd('settings', { group: 'Panels' }),
      cmd('pi', { group: 'Hosts' }),
      cmd('lock', { group: 'Actions' }),
      cmd('pi in SFTP', { group: 'SFTP' }),
    ]);
    expect(sections.map((s) => s.group)).toEqual(['Hosts', 'SFTP', 'Panels', 'Actions']);
  });
});
