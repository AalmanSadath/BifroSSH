import { useState, useEffect, useRef, type RefObject } from 'react';
import { listen } from '@tauri-apps/api/event';
import * as ipc from '../../ipc';
import type { Conflict, TransferProgress, TransferSummary } from '../../types';
import {
  cancel as cancelItem, clearFinished, enqueue, finished, nextToRun, progressed, prune, requeue,
  resumable, start, type QueueItem,
} from '../../transferQueue';
import { describeTransfer } from '../../transferStatus';
import { batchSettled, record, take, type Mismatch, type Pending } from '../../mismatches';
import type { ConflictAnswer, ConflictPrompt } from './ConflictDialog';
import { emptySummary } from './panes';
import type { Pane } from './usePane';

/** What a queued row does when its turn comes. */
export interface TransferJob {
  /** The drop it came in with; "do this for the rest" is scoped to it. */
  batch: string;
  target: 'left' | 'right';
  run: (transferId: string, conflict: Conflict) => Promise<TransferSummary>;
  check: () => Promise<string[]>;
  /**
   * Sends named files of this transfer again, over what is there. Absent on
   * a compressed copy: a tar stream is one file the far end unpacks, and
   * naming one of the files inside it means nothing.
   */
  recopy?: (transferId: string, destRoot: string, rels: string[]) => Promise<TransferSummary>;
}

/** One entry of a drop, as handed to `enqueueBatch`. */
export type JobSpec = Pick<TransferJob, 'run' | 'check' | 'recopy'> & { name: string };

/**
 * The transfer queue, and the two questions it can stop to ask: what to do
 * about files already at the destination, and whether to send again the
 * resumed files that did not match.
 *
 * `panes` is read when a row runs rather than when it was queued, to tell
 * the destination pane what happened and to refresh it. `onEnqueue` runs on
 * every drop; the panel uses it to take the drop highlight down.
 */
export function useTransferQueue(panes: RefObject<{ left: Pane; right: Pane }>, onEnqueue: () => void) {
  /**
   * The transfer queue. Every dropped entry is one row; rows run one at a
   * time in the order dropped. The list is kept in a ref beside the state
   * because the pump is a loop that reads it between awaits, when the
   * render's copy is already old.
   */
  const [queue, setQueueState] = useState<QueueItem[]>([]);
  const queueRef = useRef<QueueItem[]>([]);
  const updateQueue = (f: (q: QueueItem[]) => QueueItem[]) => {
    queueRef.current = f(queueRef.current);
    setQueueState(queueRef.current);
  };
  /** What each row does when its turn comes; the row itself is only for show. */
  const jobsRef = useRef(new Map<string, TransferJob>());
  /** "Do this for the rest" answers, by the batch they were given for. */
  const batchPolicyRef = useRef(new Map<string, Conflict>());
  const pumpingRef = useRef(false);

  useEffect(() => {
    const unlisten = listen<TransferProgress>('sftp-progress', (e) => {
      updateQueue((q) => progressed(q, e.payload, Date.now()));
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  /**
   * Re-renders the queue once a second while it has anything in it.
   *
   * Speed and ETA are worked out from the last event during render, so when
   * the events stop the bar keeps showing whatever it last computed. Nothing
   * re-rendered, so a transfer whose server had gone displayed a healthy rate
   * and a falling ETA that never fell. The tick is what lets the bar notice
   * its own silence, and what lets finished rows leave on their own.
   */
  const [, setNow] = useState(0);
  const queueBusy = queue.length > 0;
  useEffect(() => {
    if (!queueBusy) return;
    const id = setInterval(() => {
      setNow(Date.now());
      updateQueue((q) => prune(q, Date.now()));
    }, 1000);
    return () => clearInterval(id);
  }, [queueBusy]);

  // Resumed files whose copy did not match, gathered per batch until the
  // batch has finished. A ref rather than state: the pump reads and clears it
  // between awaits, where a re-render is too late to be of use.
  const pendingRef = useRef<Pending>({});
  const [mismatches, setMismatches] = useState<{ batch: string; items: Mismatch[] } | null>(null);

  /** Whether a row is still named by something waiting to be asked about. */
  function waitingOn(id: string): boolean {
    return Object.values(pendingRef.current).some((items) => items.some((m) => m.jobId === id));
  }

  /**
   * The dialog's Copy again: one new row per row that had mismatches, each
   * sending only the files it named. Ordinary queue rows, so they report,
   * cancel and fail like anything else.
   */
  function copyAgain(items: Mismatch[]) {
    setMismatches(null);
    const first = jobsRef.current.get(items[0]?.jobId ?? '');
    if (!first) return;
    enqueueBatch(first.target, items.flatMap((m) => {
      const job = jobsRef.current.get(m.jobId);
      const again = job?.recopy;
      if (!again) return [];
      return [{
        name: m.name,
        run: (id: string) => again(id, m.landed, m.rels),
        check: async () => [],
        recopy: again,
      }];
    }));
    for (const m of items) jobsRef.current.delete(m.jobId);
  }

  /** The dialog's Leave: nothing more is sent, and the jobs behind it can go. */
  function leaveMismatches(items: Mismatch[]) {
    setMismatches(null);
    for (const m of items) jobsRef.current.delete(m.jobId);
  }

  /**
   * Puts the question up and waits for the answer. Held as a resolver in
   * state because the pump is a loop that has to pause on it; the dialog
   * itself is plain JSX rendered while the state is set. One slot is enough
   * because one transfer runs at a time.
   */
  const [conflictPrompt, setConflictPrompt] = useState<{ prompt: ConflictPrompt; resolve: (a: ConflictAnswer | null) => void } | null>(null);
  function askConflict(prompt: ConflictPrompt): Promise<ConflictAnswer | null> {
    return new Promise((resolve) => setConflictPrompt({ prompt, resolve }));
  }

  function answerConflict(answer: ConflictAnswer | null) {
    conflictPrompt?.resolve(answer);
    setConflictPrompt(null);
  }

  /** One drop's entries become rows of one batch, then the pump is woken. */
  function enqueueBatch(target: 'left' | 'right', items: JobSpec[]) {
    const dst = panes.current![target];
    const destination = dst.mode === 'local' ? 'local' : dst.serverName;
    const batch = crypto.randomUUID();
    onEnqueue();
    for (const item of items) {
      const id = crypto.randomUUID();
      jobsRef.current.set(id, { batch, target, run: item.run, check: item.check, recopy: item.recopy });
      updateQueue((q) => enqueue(q, { id, name: item.name, target, destination }));
    }
    void pump();
  }

  /**
   * Runs the queue until it is empty. One at a time, in order: the link
   * gains nothing from two copies at once, and one running transfer keeps
   * the conflict prompt about one thing. A cancel answered on the prompt
   * ends the whole batch it belongs to, since carrying on with the next
   * file is not what "stop" means; a cancel pressed on a running row stops
   * that row only.
   */
  async function pump() {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    try {
      for (;;) {
        const next = nextToRun(queueRef.current);
        if (!next) break;
        const job = jobsRef.current.get(next.id);
        if (!job) { updateQueue((q) => cancelItem(q, next.id)); continue; }
        updateQueue((q) => start(q, next.id));
        const dst = () => panes.current![job.target];
        try {
          // A resume is already an answer to "what about the file that is
          // there", so it neither asks nor takes the batch's earlier answer.
          let conflict: Conflict = next.resume ? 'resume' : batchPolicyRef.current.get(job.batch) ?? 'overwrite';
          if (!next.resume && !batchPolicyRef.current.has(job.batch)) {
            const files = await job.check();
            if (files.length > 0) {
              const more = queueRef.current.some((q) => q.id !== next.id && q.status === 'queued' && jobsRef.current.get(q.id)?.batch === job.batch);
              const answer = await askConflict({ name: next.name, files, more });
              if (answer === null) {
                // The rest of the batch leaves with it.
                updateQueue((q) => finished(q, next.id, { summary: emptySummary({ cancelled: true }) }, Date.now()));
                for (const row of queueRef.current) {
                  if (row.status === 'queued' && jobsRef.current.get(row.id)?.batch === job.batch) {
                    updateQueue((q) => cancelItem(q, row.id));
                    jobsRef.current.delete(row.id);
                  }
                }
                continue;
              }
              conflict = answer.choice;
              if (answer.applyToAll) batchPolicyRef.current.set(job.batch, answer.choice);
            }
          }
          const summary = await job.run(next.id, conflict);
          updateQueue((q) => finished(q, next.id, { summary }, Date.now()));
          const said = describeTransfer(summary);
          if (said) dst().say(said);
          if (summary.mismatched.length > 0 && job.recopy && summary.landed) {
            pendingRef.current = record(pendingRef.current, job.batch, {
              jobId: next.id,
              name: next.name,
              landed: summary.landed,
              rels: summary.mismatched,
            });
          }
        } catch (e) {
          updateQueue((q) => finished(q, next.id, { error: String(e) }, Date.now()));
        } finally {
          // The job is what a Resume, or a Copy again, would run, so it stays
          // as long as either is still on offer.
          const row = queueRef.current.find((q) => q.id === next.id);
          const wanted = (row && resumable(row)) || waitingOn(next.id);
          if (!wanted) jobsRef.current.delete(next.id);
          // Whether it finished, failed part way or was stopped, there is
          // something new on the destination to show.
          await dst().refresh();
        }
        // Asked once the drop it belongs to has nothing left to run, rather
        // than once per row, which would put a dialog in front of every file
        // of a batch.
        const batch = job.batch;
        if (
          pendingRef.current[batch] !== undefined
          && batchSettled(queueRef.current, (id) => jobsRef.current.get(id)?.batch, batch)
        ) {
          const { taken, rest } = take(pendingRef.current, batch);
          pendingRef.current = rest;
          if (taken.length > 0) setMismatches({ batch, items: taken });
        }
      }
    } finally {
      pumpingRef.current = false;
    }
  }

  /** The Resume on a settled row: back into the queue, continuing what it left. */
  function resumeRow(id: string) {
    updateQueue((q) => requeue(q, id));
    void pump();
  }

  /** The ✕ on a row: a queued one leaves, the running one is asked to stop, a finished one is dismissed. */
  function cancelRow(id: string) {
    const row = queueRef.current.find((q) => q.id === id);
    if (!row) return;
    if (row.status === 'running') ipc.sftpCancelTransfer(id).catch(() => {});
    else jobsRef.current.delete(id);
    updateQueue((q) => cancelItem(q, id));
  }

  return {
    queue,
    enqueueBatch,
    resumeRow,
    cancelRow,
    clearFinished: () => updateQueue(clearFinished),
    conflictPrompt: conflictPrompt?.prompt ?? null,
    answerConflict,
    mismatches: mismatches?.items ?? null,
    copyAgain,
    leaveMismatches,
  };
}
