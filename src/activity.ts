/**
 * What a tab is doing, read from the OSC 133 marks a shell emits around each
 * command.
 *
 * The sequence is `A` at the start of a prompt, `B` where the prompt ends and
 * typing begins, `C` where the command starts producing output, and
 * `D;<exit>` when it is over. Only C and D say anything about work: a tab is
 * busy between them. Nothing else in the stream is looked at, so a shell that
 * emits no marks simply has no chip, rather than a guess.
 *
 * Pure, so the parsing and the timing have tests without a terminal.
 */

export type MarkKind = 'prompt' | 'input' | 'output' | 'done';

export interface Mark {
  kind: MarkKind;
  /** The command's exit code, for `done`; null where the shell said none. */
  exit: number | null;
}

export interface Activity {
  /** A command is running: output started and has not been rounded off. */
  busy: boolean;
  /** When it started, for the elapsed time on the chip. */
  since: number;
  /** The last command's exit code, once it has one. */
  exit: number | null;
  /** When the last command finished, which is how long its mark is shown. */
  endedAt: number | null;
  /**
   * Whether the tab was being looked at when the command finished.
   *
   * A result nobody was there for is the one worth keeping: it waits on the
   * tab until the tab is opened, rather than expiring against a window the
   * user never saw.
   */
  seen: boolean;
}

/** How long a finished command's tick or cross stays on the tab. */
export const DONE_SHOWN_MS = 6_000;

/** Below this, a running command is not worth a chip of its own. */
export const BUSY_AFTER_MS = 1_000;

/**
 * One OSC 133 payload, which is everything after `133;`.
 *
 * Shells add parameters of their own (`A;aid=3`, `D;1;err=1`), so only the
 * first field is read, and anything unrecognised is ignored rather than
 * guessed at.
 */
export function parseMark(data: string): Mark | null {
  const [head, ...rest] = data.split(';');
  switch (head) {
    case 'A': return { kind: 'prompt', exit: null };
    case 'B': return { kind: 'input', exit: null };
    case 'C': return { kind: 'output', exit: null };
    case 'D': {
      const code = Number.parseInt(rest[0] ?? '', 10);
      return { kind: 'done', exit: Number.isNaN(code) ? null : code };
    }
    default: return null;
  }
}

export const IDLE: Activity = { busy: false, since: 0, exit: null, endedAt: null, seen: true };

/**
 * The state a mark moves a tab into.
 *
 * A prompt ends a command the shell never rounded off, and otherwise changes
 * nothing: bash sends D and A together from one PROMPT_COMMAND, so a prompt
 * that cleared the last result would wipe the tick in the same breath as
 * setting it. What ends a result's life is its own window, and the next
 * command starting. `B` means the shell is waiting for typing, which is the
 * same as idle and is left alone deliberately: some shells emit B without
 * ever emitting A.
 */
export function nextActivity(
  state: Activity | undefined,
  mark: Mark,
  now: number,
  watched: boolean,
): Activity {
  const at = state ?? IDLE;
  switch (mark.kind) {
    case 'output':
      return { busy: true, since: now, exit: null, endedAt: null, seen: true };
    case 'done':
      return { busy: false, since: at.since, exit: mark.exit, endedAt: now, seen: watched };
    case 'prompt':
      return at.busy
        ? { busy: false, since: at.since, exit: at.exit, endedAt: now, seen: watched }
        : at;
    case 'input':
      return at;
  }
}

/**
 * The tab has been opened, so whatever it was holding has now been seen. The
 * window starts here rather than ending: the mark stays a moment so the
 * person looking at the tab reads it, and then goes.
 */
export function watched(state: Activity | undefined, now: number): Activity | undefined {
  if (!state || state.seen) return state;
  return { ...state, seen: true, endedAt: now };
}

export interface Chip {
  kind: 'busy' | 'done' | 'failed';
  text: string;
  title: string;
}

/**
 * What the tab shows, or nothing.
 *
 * A command that is over in half a second is not news, and neither is a
 * result read minutes ago, so both have a window. A failure keeps its exit
 * code: "it went wrong" and "it went wrong with 127" are different amounts of
 * help.
 */
export function activityChip(state: Activity | undefined, now: number): Chip | null {
  if (!state) return null;
  if (state.busy) {
    const ms = now - state.since;
    if (ms < BUSY_AFTER_MS) return null;
    return { kind: 'busy', text: DOT, title: `Running for ${elapsed(ms)}` };
  }
  if (state.endedAt === null) return null;
  // A result the user was not there for keeps until the tab is opened; one
  // they were watching has been read already and goes on its own.
  if (state.seen && now - state.endedAt >= DONE_SHOWN_MS) return null;
  const waiting = state.seen ? '' : ', still waiting to be looked at';
  if (state.exit === null || state.exit === 0) {
    return { kind: 'done', text: DOT, title: `The last command finished${waiting}` };
  }
  return {
    kind: 'failed',
    text: `${DOT} ${state.exit}`,
    title: `The last command exited ${state.exit}${waiting}`,
  };
}

/**
 * One glyph for every state, told apart by colour: amber while a command
 * runs, then green or red for how it ended. A counter climbing on the tab
 * drew the eye to a number nobody needs to read; how long it has been running
 * is still there on hover.
 */
const DOT = '●';

/**
 * Whether anything has a chip that will change, which is what the tab strip
 * ticks for. A finished command counts only while its mark is still counting
 * down: `endedAt` is never cleared, so asking about it alone would leave a
 * timer running on an idle window for the rest of the session, and a mark
 * waiting to be looked at does not change until it is.
 */
export function anyBusy(states: Record<string, Activity>, now: number): boolean {
  return Object.values(states).some(
    (a) => a.busy || (a.seen && a.endedAt !== null && now - a.endedAt < DONE_SHOWN_MS),
  );
}

function elapsed(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}
