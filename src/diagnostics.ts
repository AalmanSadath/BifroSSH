/**
 * What went wrong in this session, kept so it can be handed over.
 *
 * Every error the app shows was a single slot: a banner that the next one
 * replaced, a crash screen that a reload cleared. A bug report then held
 * whatever the user remembered of the first one. This keeps the last few, in
 * memory only: they are for the session in front of the user, and writing
 * error text to disk would be a second thing to get wrong.
 */

export interface DiagError {
  /** Epoch ms. */
  at: number;
  /** Where it surfaced: a banner, a tab, the crash screen, an uncaught throw. */
  where: string;
  message: string;
}

/** How many are kept. Enough for the lead-up to a failure, not a log. */
export const KEPT_ERRORS = 20;

/**
 * The list with one more on the end, the oldest dropped past the cap.
 *
 * The same message arriving twice in a row from the same place is one entry:
 * a retry loop that fails the same way every few seconds would otherwise
 * push everything that came before it out of the list.
 */
export function withError(list: DiagError[], entry: DiagError, cap = KEPT_ERRORS): DiagError[] {
  const last = list[list.length - 1];
  if (last && last.where === entry.where && last.message === entry.message) {
    return [...list.slice(0, -1), entry];
  }
  const next = [...list, entry];
  return next.length > cap ? next.slice(next.length - cap) : next;
}
