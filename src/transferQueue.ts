/**
 * The SFTP panel's transfer queue: what is waiting, what is running, what
 * just finished. Pure reducers over a list so the bookkeeping has tests;
 * the panel owns the list and does the transfers.
 */

import type { TransferProgress, TransferSummary } from './types';

export type QueueStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface QueueItem {
  id: string;
  /** What is shown: the dropped entry's name. */
  name: string;
  /** Which pane receives it. */
  target: 'left' | 'right';
  /** The destination host, or "local". */
  destination: string;
  status: QueueStatus;
  /** Set once the first progress event lands. */
  progress: (TransferProgress & { startTime: number; at: number }) | null;
  /** Why it failed, when it did. */
  error: string | null;
  summary: TransferSummary | null;
  /** When the row reached a final state; finished rows leave after a while. */
  endedAt: number | null;
  /** The user has asked the running one to stop and it has not yet. */
  cancelling: boolean;
}

/** How long a done or cancelled row stays before it leaves on its own. */
export const LINGER_MS = 8_000;

export function enqueue(
  queue: QueueItem[],
  item: Pick<QueueItem, 'id' | 'name' | 'target' | 'destination'>,
): QueueItem[] {
  return [...queue, {
    ...item,
    status: 'queued',
    progress: null,
    error: null,
    summary: null,
    endedAt: null,
    cancelling: false,
  }];
}

/** The next item to run, when nothing is running. */
export function nextToRun(queue: QueueItem[]): QueueItem | null {
  if (queue.some((q) => q.status === 'running')) return null;
  return queue.find((q) => q.status === 'queued') ?? null;
}

export function start(queue: QueueItem[], id: string): QueueItem[] {
  return queue.map((q) => (q.id === id ? { ...q, status: 'running' } : q));
}

export function progressed(queue: QueueItem[], p: TransferProgress, now: number): QueueItem[] {
  return queue.map((q) => {
    if (q.id !== p.transfer_id) return q;
    return { ...q, progress: { ...p, startTime: q.progress?.startTime ?? now, at: now } };
  });
}

/** The running item's outcome. A summary marked cancelled is a cancel. */
export function finished(
  queue: QueueItem[],
  id: string,
  outcome: { summary: TransferSummary } | { error: string },
  now: number,
): QueueItem[] {
  return queue.map((q) => {
    if (q.id !== id) return q;
    if ('error' in outcome) return { ...q, status: 'failed', error: outcome.error, endedAt: now };
    return {
      ...q,
      status: outcome.summary.cancelled ? 'cancelled' : 'done',
      summary: outcome.summary,
      endedAt: now,
    };
  });
}

/**
 * The user's ✕. A queued item leaves at once; the running one is marked,
 * and the caller sends the cancel; a finished one is dismissed.
 */
export function cancel(queue: QueueItem[], id: string): QueueItem[] {
  return queue.flatMap((q) => {
    if (q.id !== id) return [q];
    if (q.status === 'running') return [{ ...q, cancelling: true }];
    return [];
  });
}

/** Done and cancelled rows that have lingered long enough leave. Failed rows stay. */
export function prune(queue: QueueItem[], now: number): QueueItem[] {
  return queue.filter((q) => {
    if (q.status !== 'done' && q.status !== 'cancelled') return true;
    return q.endedAt === null || now - q.endedAt < LINGER_MS;
  });
}

/** Everything that has finished, however it finished. */
export function clearFinished(queue: QueueItem[]): QueueItem[] {
  return queue.filter((q) => q.status === 'queued' || q.status === 'running');
}
