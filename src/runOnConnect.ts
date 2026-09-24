/**
 * The tail of a host's startup command.
 *
 * What a host runs on connect is typed at the shell, so the shell echoes it,
 * and a long line, like the shell integration snippet, sits in the scrollback
 * above the first prompt. Ending the line with `clear` leaves the screen as
 * if nothing had been typed.
 *
 * Kept as text in the field rather than as a flag of its own: the field is
 * what runs, and a checkbox that changed something invisible would be a
 * second place for the answer to live.
 */

const CLEAR = 'clear';

/** Whether the command already ends by clearing the screen. */
export function hasClear(command: string): boolean {
  return lastSegment(command) === CLEAR;
}

/** The command with the clear added or taken off the end. */
export function withClear(command: string, on: boolean): string {
  const trimmed = command.trim();
  if (on === hasClear(trimmed)) return trimmed;
  if (on) return trimmed === '' ? CLEAR : `${trimmed}; ${CLEAR}`;
  const cut = trimmed.lastIndexOf(';');
  return cut === -1 ? '' : trimmed.slice(0, cut).trimEnd();
}

/**
 * What follows the last `;`. Naive on purpose: a semicolon inside quotes
 * makes the tail something other than a bare `clear`, which is the only
 * answer this has to be right about.
 */
function lastSegment(command: string): string {
  const trimmed = command.trim();
  const cut = trimmed.lastIndexOf(';');
  return (cut === -1 ? trimmed : trimmed.slice(cut + 1)).trim();
}
