/**
 * Resumed files that did not match the original, gathered per drop so the
 * user is asked once about a batch rather than once per row.
 *
 * Pure bookkeeping over a record keyed by batch; the panel owns the state and
 * runs the copies.
 */

import type { QueueItem } from './transferQueue';

/** One row's worth: what was transferred, and which of its files are wrong. */
export interface Mismatch {
  /** The queue row, which is also the job that knows how to send them again. */
  jobId: string;
  /** What the row was called, which is the name a single file goes by. */
  name: string;
  /** Where that transfer landed, directory and name together. */
  landed: string;
  /** Paths relative to the transfer root; a single file is the empty string. */
  rels: string[];
}

export type Pending = Record<string, Mismatch[]>;

export function record(pending: Pending, batch: string, mismatch: Mismatch): Pending {
  return { ...pending, [batch]: [...(pending[batch] ?? []), mismatch] };
}

/**
 * Whether a batch has nothing left to run.
 *
 * The dialog waits for this: asking about the first row while the rest of the
 * drop is still copying would put a question in front of the user for every
 * row, which is the thing one dialog per batch exists to avoid.
 */
export function batchSettled(
  queue: QueueItem[],
  batchOf: (id: string) => string | undefined,
  batch: string,
): boolean {
  return !queue.some(
    (q) => (q.status === 'queued' || q.status === 'running') && batchOf(q.id) === batch,
  );
}

/** A file's name as the dialog shows it; a single file has no relative path. */
export function shownPath(mismatch: Mismatch, rel: string): string {
  return rel === '' ? mismatch.name : rel;
}

/** How many files the dialog is about. */
export function countOf(mismatches: Mismatch[]): number {
  return mismatches.reduce((n, m) => n + m.rels.length, 0);
}

/**
 * The batch's mismatches, and what is left without them. Taken rather than
 * read so the dialog cannot open a second time on the same answer.
 */
export function take(pending: Pending, batch: string): { taken: Mismatch[]; rest: Pending } {
  const taken = pending[batch] ?? [];
  const rest = { ...pending };
  delete rest[batch];
  return { taken, rest };
}
