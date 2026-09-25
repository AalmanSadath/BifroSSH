import { describe, expect, it } from 'vitest';
import { formatDiagnostics, withError, withoutHome, type DiagError, type DiagFacts } from './diagnostics';

const err = (at: number, message: string, where = 'banner'): DiagError => ({ at, where, message });

describe('withError', () => {
  it('keeps errors in the order they happened', () => {
    const list = withError(withError([], err(1, 'first')), err(2, 'second'));
    expect(list.map((e) => e.message)).toEqual(['first', 'second']);
  });

  it('drops the oldest past the cap', () => {
    let list: DiagError[] = [];
    for (let i = 0; i < 5; i++) list = withError(list, err(i, `e${i}`), 3);
    expect(list.map((e) => e.message)).toEqual(['e2', 'e3', 'e4']);
  });

  it('folds a repeat into the last entry, keeping its newer time', () => {
    const list = withError(withError([], err(1, 'refused')), err(9, 'refused'));
    expect(list).toEqual([err(9, 'refused')]);
  });

  it('keeps a repeat that came from somewhere else, or after something else', () => {
    const fromTab = withError([err(1, 'refused')], err(2, 'refused', 'tab'));
    expect(fromTab).toHaveLength(2);
    const between = withError([err(1, 'refused'), err(2, 'other')], err(3, 'refused'));
    expect(between).toHaveLength(3);
  });
});

const facts: DiagFacts = {
  version: '0.14.5',
  platform: 'linux',
  userAgent: 'Mozilla/5.0 AppleWebKit/605.1.15',
  window: { width: 1400, height: 900, scale: 2 },
  dataDir: '/home/sam/.local/share/bifrossh',
  home: '/home/sam',
  counts: { hosts: 12, keys: 3, identities: 1, tunnels: 2, tabs: 4 },
  settings: { app_theme: 'dark', keepalive_interval_secs: 30, verify_transfers: false },
};

describe('formatDiagnostics', () => {
  it('opens with the version and platform', () => {
    expect(formatDiagnostics(facts, []).split('\n')[0]).toBe('BifroSSH 0.14.5 on linux');
  });

  it('says so when nothing went wrong', () => {
    expect(formatDiagnostics(facts, [])).toContain('No errors this session.');
  });

  it('lists errors oldest first with an ISO time, keeping a long message whole', () => {
    const long = 'x'.repeat(500);
    const text = formatDiagnostics(facts, [err(0, 'first'), err(1000, long, 'tab')]);
    expect(text).toContain('Errors this session, oldest first (2):');
    expect(text).toContain('1970-01-01T00:00:00.000Z [banner] first');
    expect(text).toContain(`1970-01-01T00:00:01.000Z [tab] ${long}`);
    expect(text.indexOf('first')).toBeLessThan(text.indexOf(long));
  });

  it('carries the counts and settings but not the user name in the data path', () => {
    const text = formatDiagnostics(facts, []);
    expect(text).toContain('Hosts 12 · keys 3 · identities 1 · tunnels 2 · open tabs 4');
    expect(text).toContain('Settings: app_theme=dark keepalive_interval_secs=30 verify_transfers=false');
    expect(text).toContain('Data: ~/.local/share/bifrossh');
    expect(text).not.toContain('sam');
  });
});

describe('withoutHome', () => {
  it('writes the home directory as a tilde', () => {
    expect(withoutHome('/home/sam/data', '/home/sam')).toBe('~/data');
    expect(withoutHome('/home/sam', '/home/sam/')).toBe('~');
    expect(withoutHome('C:\\Users\\sam\\AppData', 'C:\\Users\\sam')).toBe('~\\AppData');
  });

  it('leaves a path outside it, or one that only starts with the same letters', () => {
    expect(withoutHome('/srv/data', '/home/sam')).toBe('/srv/data');
    expect(withoutHome('/home/samantha/data', '/home/sam')).toBe('/home/samantha/data');
    expect(withoutHome('/srv/data', '')).toBe('/srv/data');
  });
});
