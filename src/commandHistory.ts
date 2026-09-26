/**
 * Commands run at a prompt, per host, and how a command line is read back out
 * of the terminal.
 *
 * Pure, so it is tested without a terminal or a store. The shell marks where
 * the prompt ends (OSC 133 B) and where the command starts running (C); what
 * lies between, on the rows the command was typed across, is the command.
 */

/** The same cap `models.rs` keeps, so the copy here never outgrows the saved one. */
export const HISTORY_CAP = 500;

/** Longer than this is a paste of a script, not a command worth suggesting. */
const MAX_COMMAND = 1000;

/**
 * Whether a command is kept.
 *
 * A command typed with a leading space is not, which is the convention shells
 * already have for "do not put this in my history" (HISTCONTROL=ignorespace,
 * HIST_IGNORE_SPACE). The text is checked as typed, before any trimming.
 */
export function worthRemembering(typed: string): boolean {
  if (typed.startsWith(' ')) return false;
  const command = typed.trim();
  return command !== '' && command.length <= MAX_COMMAND;
}

/**
 * The history with one more command in front. A command run before moves up
 * rather than appearing twice; what counts is when it was last run.
 */
export function remember(history: string[], command: string, cap = HISTORY_CAP): string[] {
  return [command, ...history.filter((c) => c !== command)].slice(0, cap);
}

/** The part of the terminal a command line is read from. */
export interface RowSource {
  /** Row text from `column` on, or undefined past the end of the buffer. */
  text(row: number, column: number): string | undefined;
  /** Whether a row continues the one above it because the line wrapped. */
  wrapped(row: number): boolean;
}

/**
 * The command typed from `(row, column)`: the rest of that row and every row
 * that wrapped on from it.
 *
 * Only the typed line is ever read, between the end of the prompt and the
 * moment the command starts. A password asked for by the command itself comes
 * after that, and is never on these rows.
 */
export function readCommand(rows: RowSource, row: number, column: number): string {
  let out = rows.text(row, column) ?? '';
  for (let r = row + 1; rows.wrapped(r); r++) {
    const next = rows.text(r, 0);
    if (next === undefined) break;
    out += next;
  }
  return out.replace(/\s+$/, '');
}
