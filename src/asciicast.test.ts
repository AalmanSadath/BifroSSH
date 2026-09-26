import { describe, expect, it } from 'vitest';
import { clockTime, compressIdle, eventsBy, parseCast, parseSize, recordingName, sortRecordings } from './asciicast';

const V2 = [
  '{"version":2,"width":100,"height":30,"timestamp":1,"title":"web"}',
  '[0.5,"o","hello"]',
  '[1.0,"i","typed"]',
  '[2.0,"r","120x40"]',
  'not json',
  '[3.25,"o","\\u001b[31mred"]',
  '',
].join('\n');

describe('parseCast', () => {
  it('reads a v2 recording, keeping output and resizes', () => {
    const cast = parseCast(V2);
    expect([cast.cols, cast.rows, cast.title]).toEqual([100, 30, 'web']);
    expect(cast.events).toEqual([
      { t: 0.5, kind: 'o', data: 'hello' },
      { t: 2, kind: 'r', data: '120x40' },
      { t: 3.25, kind: 'o', data: '\x1b[31mred' },
    ]);
    expect(cast.duration).toBe(3.25);
  });

  it('reads v3, whose times are gaps since the last event', () => {
    const cast = parseCast('{"version":3,"term":{"cols":90,"rows":20}}\n[0.5,"o","a"]\n[0.25,"m",""]\n[1,"o","b"]\n');
    expect([cast.cols, cast.rows]).toEqual([90, 20]);
    expect(cast.events.map((e) => e.t)).toEqual([0.5, 1.75]);
  });

  it('says what is wrong with a file it cannot play', () => {
    expect(() => parseCast('')).toThrow('empty');
    expect(() => parseCast('hello')).toThrow('not an asciicast');
    expect(() => parseCast('{"version":1,"stdout":[]}')).toThrow('v1');
    expect(() => parseCast('[1,"o","x"]')).toThrow('not an asciicast');
  });

  it('falls back to 80x24 when the header has no size', () => {
    const cast = parseCast('{"version":2}\n');
    expect([cast.cols, cast.rows]).toEqual([80, 24]);
  });
});

describe('playback helpers', () => {
  const events = [0, 1, 10, 11, 100].map((t) => ({ t, kind: 'o' as const, data: '' }));

  it('cuts long pauses down', () => {
    expect(compressIdle(events, 2).map((e) => e.t)).toEqual([0, 1, 3, 4, 6]);
  });

  it('counts the events that have happened by a time', () => {
    expect(eventsBy(events, -1)).toBe(0);
    expect(eventsBy(events, 1)).toBe(2);
    expect(eventsBy(events, 50)).toBe(4);
    expect(eventsBy(events, 1000)).toBe(5);
  });

  it('reads a resize', () => {
    expect(parseSize('120x40')).toEqual({ cols: 120, rows: 40 });
    expect(parseSize('0x40')).toBeNull();
    expect(parseSize('big')).toBeNull();
  });

  it('writes a clock', () => {
    expect(clockTime(65.9)).toBe('1:05');
    expect(clockTime(3725)).toBe('1:02:05');
  });
});

describe('recording files', () => {
  it('are known by the host and the moment in their name', () => {
    const r = recordingName('prod_web_20260926-141320_0123abcd.cast');
    expect(r.label).toBe('prod web');
    expect(r.at?.toISOString()).toBe('2026-09-26T14:13:20.000Z');
  });

  it('named some other way keep their name and have no time', () => {
    expect(recordingName('demo.cast')).toEqual({ label: 'demo', at: null });
  });

  it('are listed newest first', () => {
    const files = [
      { name: 'a_20260101-000000_11111111.cast', modified: 0 },
      { name: 'other.cast', modified: Date.UTC(2026, 5, 1) / 1000 },
      { name: 'b_20260901-000000_22222222.cast', modified: 0 },
    ];
    expect(sortRecordings(files).map((f) => f.name)).toEqual([
      'b_20260901-000000_22222222.cast',
      'other.cast',
      'a_20260101-000000_11111111.cast',
    ]);
  });
});
