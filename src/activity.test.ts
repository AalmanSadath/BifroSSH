import { describe, expect, it } from 'vitest';
import { BUSY_AFTER_MS, DONE_SHOWN_MS, IDLE, activityChip, anyBusy, nextActivity, parseMark } from './activity';

const mark = (data: string) => {
  const m = parseMark(data);
  if (m === null) throw new Error(`nothing parsed from ${data}`);
  return m;
};

describe('parseMark', () => {
  it('reads the four marks, and the exit code on the last', () => {
    expect(parseMark('A')).toEqual({ kind: 'prompt', exit: null });
    expect(parseMark('B')).toEqual({ kind: 'input', exit: null });
    expect(parseMark('C')).toEqual({ kind: 'output', exit: null });
    expect(parseMark('D;0')).toEqual({ kind: 'done', exit: 0 });
    expect(parseMark('D;127')).toEqual({ kind: 'done', exit: 127 });
  });

  it('ignores the parameters shells add of their own', () => {
    expect(parseMark('A;aid=3')).toEqual({ kind: 'prompt', exit: null });
    expect(parseMark('D;1;err=1')).toEqual({ kind: 'done', exit: 1 });
    expect(parseMark('D')).toEqual({ kind: 'done', exit: null });
  });

  it('reads nothing from a mark it does not know', () => {
    expect(parseMark('P;Cwd=/tmp')).toBeNull();
    expect(parseMark('')).toBeNull();
  });
});

describe('nextActivity', () => {
  it('runs from the start of output to the end of the command', () => {
    let state = nextActivity(undefined, mark('A'), 100);
    expect(state.busy).toBe(false);
    state = nextActivity(state, mark('B'), 200);
    expect(state.busy).toBe(false);
    state = nextActivity(state, mark('C'), 300);
    expect(state).toMatchObject({ busy: true, since: 300 });
    state = nextActivity(state, mark('D;0'), 900);
    expect(state).toMatchObject({ busy: false, exit: 0, endedAt: 900 });
  });

  it('keeps the exit code of a command that failed', () => {
    const running = nextActivity(IDLE, mark('C'), 100);
    expect(nextActivity(running, mark('D;127'), 200).exit).toBe(127);
  });

  it('clears the last command at the next prompt, so a tick does not outlive its screen', () => {
    const done = nextActivity(nextActivity(IDLE, mark('C'), 100), mark('D;0'), 200);
    expect(nextActivity(done, mark('A'), 300)).toEqual(IDLE);
  });

  it('ends a command at the next prompt when the shell sends no D', () => {
    const running = nextActivity(IDLE, mark('C'), 100);
    const ended = nextActivity(running, mark('A'), 500);
    expect(ended).toMatchObject({ busy: false, endedAt: 500 });
  });
});

describe('activityChip', () => {
  it('says nothing about a tab that has sent no marks', () => {
    expect(activityChip(undefined, 1000)).toBeNull();
    expect(activityChip(IDLE, 1000)).toBeNull();
  });

  it('waits a moment before calling a command long enough to mention', () => {
    const running = nextActivity(IDLE, mark('C'), 0);
    expect(activityChip(running, BUSY_AFTER_MS - 1)).toBeNull();
    expect(activityChip(running, 12_000)).toEqual({ kind: 'busy', text: '12s', title: 'Running for 12s' });
    expect(activityChip(running, 90_000)?.text).toBe('1m 30s');
  });

  it('shows how a command ended, for a while', () => {
    const ok = nextActivity(nextActivity(IDLE, mark('C'), 0), mark('D;0'), 1000);
    expect(activityChip(ok, 2000)).toMatchObject({ kind: 'done', text: '✓' });
    expect(activityChip(ok, 1000 + DONE_SHOWN_MS)).toBeNull();

    const failed = nextActivity(nextActivity(IDLE, mark('C'), 0), mark('D;127'), 1000);
    expect(activityChip(failed, 2000)).toMatchObject({ kind: 'failed', text: '✗ 127' });
  });
});

describe('anyBusy', () => {
  it('is true while anything is running or has just finished', () => {
    const running = nextActivity(IDLE, mark('C'), 0);
    expect(anyBusy({})).toBe(false);
    expect(anyBusy({ a: IDLE })).toBe(false);
    expect(anyBusy({ a: running })).toBe(true);
    expect(anyBusy({ a: nextActivity(running, mark('D;0'), 100) })).toBe(true);
  });
});
