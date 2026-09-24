import { describe, expect, it } from 'vitest';
import { BUSY_AFTER_MS, DONE_SHOWN_MS, IDLE, activityChip, anyBusy, nextActivity, parseMark, watched } from './activity';

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
    let state = nextActivity(undefined, mark('A'), 100, true);
    expect(state.busy).toBe(false);
    state = nextActivity(state, mark('B'), 200, true);
    expect(state.busy).toBe(false);
    state = nextActivity(state, mark('C'), 300, true);
    expect(state).toMatchObject({ busy: true, since: 300 });
    state = nextActivity(state, mark('D;0'), 900, true);
    expect(state).toMatchObject({ busy: false, exit: 0, endedAt: 900 });
  });

  it('keeps the exit code of a command that failed', () => {
    const running = nextActivity(IDLE, mark('C'), 100, true);
    expect(nextActivity(running, mark('D;127'), 200, true).exit).toBe(127);
  });

  it('keeps what a command ended as when the prompt follows it', () => {
    // bash sends D and A together from one PROMPT_COMMAND, so a prompt that
    // cleared the result would wipe the tick as it was being set.
    const done = nextActivity(nextActivity(IDLE, mark('C'), 100, true), mark('D;0'), 200, true);
    expect(nextActivity(done, mark('A'), 200, true)).toEqual(done);
  });

  it('clears the last command when the next one starts', () => {
    const done = nextActivity(nextActivity(IDLE, mark('C'), 100, true), mark('D;1'), 200, true);
    expect(nextActivity(done, mark('C'), 300, true)).toMatchObject({ busy: true, exit: null, endedAt: null });
  });

  it('ends a command at the next prompt when the shell sends no D', () => {
    const running = nextActivity(IDLE, mark('C'), 100, true);
    const ended = nextActivity(running, mark('A'), 500, true);
    expect(ended).toMatchObject({ busy: false, endedAt: 500 });
  });
});

describe('activityChip', () => {
  it('says nothing about a tab that has sent no marks', () => {
    expect(activityChip(undefined, 1000)).toBeNull();
    expect(activityChip(IDLE, 1000)).toBeNull();
  });

  it('waits a moment before calling a command long enough to mention', () => {
    const running = nextActivity(IDLE, mark('C'), 0, true);
    expect(activityChip(running, BUSY_AFTER_MS - 1)).toBeNull();
    expect(activityChip(running, 12_000)).toEqual({ kind: 'busy', text: '●', title: 'Running for 12s' });
    // How long it has been going is on the chip's tooltip, not on the tab.
    expect(activityChip(running, 90_000)?.title).toBe('Running for 1m 30s');
  });

  it('shows how a command ended, for a while', () => {
    const ok = nextActivity(nextActivity(IDLE, mark('C'), 0, true), mark('D;0'), 1000, true);
    expect(activityChip(ok, 2000)).toMatchObject({ kind: 'done', text: '●' });
    expect(activityChip(ok, 1000 + DONE_SHOWN_MS)).toBeNull();

    const failed = nextActivity(nextActivity(IDLE, mark('C'), 0, true), mark('D;127'), 1000, true);
    expect(activityChip(failed, 2000)).toMatchObject({ kind: 'failed', text: '● 127' });
  });
});

describe('a result nobody was there for', () => {
  const away = (exit: string) =>
    nextActivity(nextActivity(IDLE, mark('C'), 0, false), mark(exit), 1000, false);

  it('keeps its chip however long the tab is left alone', () => {
    const done = away('D;0');
    expect(activityChip(done, 1000 + DONE_SHOWN_MS * 100)).toMatchObject({ kind: 'done' });
    expect(activityChip(away('D;2'), 1000 + DONE_SHOWN_MS * 100)).toMatchObject({ kind: 'failed', text: '● 2' });
  });

  it('starts its goodbye when the tab is opened', () => {
    const seen = watched(away('D;0'), 50_000);
    expect(seen).toMatchObject({ seen: true, endedAt: 50_000 });
    expect(activityChip(seen, 52_000)).not.toBeNull();
    expect(activityChip(seen, 50_000 + DONE_SHOWN_MS)).toBeNull();
  });

  it('leaves a result that was already read alone', () => {
    const here = nextActivity(nextActivity(IDLE, mark('C'), 0, true), mark('D;0'), 1000, true);
    expect(watched(here, 50_000)).toBe(here);
  });

  it('does not tick for a mark that is only waiting', () => {
    expect(anyBusy({ a: away('D;0') }, 90_000)).toBe(false);
  });
});

describe('anyBusy', () => {
  it('is true while anything is running or its mark is still shown', () => {
    const running = nextActivity(IDLE, mark('C'), 0, true);
    const done = nextActivity(running, mark('D;0'), 100, true);
    expect(anyBusy({}, 1000)).toBe(false);
    expect(anyBusy({ a: IDLE }, 1000)).toBe(false);
    expect(anyBusy({ a: running }, 1000)).toBe(true);
    expect(anyBusy({ a: done }, 1000)).toBe(true);
    // Once the tick has gone there is nothing left to count, so no timer.
    expect(anyBusy({ a: done }, 100 + DONE_SHOWN_MS)).toBe(false);
  });
});
