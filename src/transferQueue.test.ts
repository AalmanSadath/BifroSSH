import { describe, expect, it } from 'vitest';
import { LINGER_MS, cancel, clearFinished, enqueue, finished, nextToRun, progressed, prune, requeue, resumable, start } from './transferQueue';
import type { TransferProgress, TransferSummary } from './types';

const item = (id: string) => ({ id, name: id, target: 'right' as const, destination: 'pi' });
const summary = (over: Partial<TransferSummary> = {}): TransferSummary =>
  ({ files: 1, directories: 0, skipped_symlinks: 0, skipped_existing: 0, renamed: 0, cancelled: false, resumed: 0, mismatched: [], resumable: 0, landed: null, verified: 0, failed: null, ...over });
const progress = (id: string, transferred: number): TransferProgress =>
  ({ transfer_id: id, file_name: 'f', transferred, total: 10, resumed_from: 0, file_index: 1, file_count: 1 });

describe('transfer queue', () => {
  it('runs one at a time, in the order queued', () => {
    let q = enqueue(enqueue([], item('a')), item('b'));
    expect(nextToRun(q)?.id).toBe('a');
    q = start(q, 'a');
    expect(nextToRun(q)).toBeNull();
    q = finished(q, 'a', { summary: summary() }, 1000);
    expect(nextToRun(q)?.id).toBe('b');
    expect(q[0].status).toBe('done');
  });

  it('keeps the first progress time and updates by id only', () => {
    let q = start(enqueue(enqueue([], item('a')), item('b')), 'a');
    q = progressed(q, progress('a', 2), 100);
    q = progressed(q, progress('a', 5), 200);
    expect(q[0].progress).toMatchObject({ transferred: 5, startTime: 100, at: 200 });
    expect(q[1].progress).toBeNull();
    q = progressed(q, progress('zzz', 1), 300);
    expect(q.map((x) => x.progress?.transferred)).toEqual([5, undefined]);
  });

  it('records a failure and a cancel as what they are', () => {
    let q = start(enqueue([], item('a')), 'a');
    expect(finished(q, 'a', { error: 'boom' }, 1)[0]).toMatchObject({ status: 'failed', error: 'boom' });
    q = finished(q, 'a', { summary: summary({ cancelled: true }) }, 1);
    expect(q[0].status).toBe('cancelled');
  });

  it('cancel removes a queued item, marks a running one, dismisses a finished one', () => {
    let q = enqueue(enqueue(enqueue([], item('a')), item('b')), item('c'));
    q = start(q, 'a');
    q = finished(q, 'a', { summary: summary() }, 1);
    q = start(q, 'b');
    q = cancel(q, 'c');
    expect(q.map((x) => x.id)).toEqual(['a', 'b']);
    q = cancel(q, 'b');
    expect(q[1]).toMatchObject({ status: 'running', cancelling: true });
    q = cancel(q, 'a');
    expect(q.map((x) => x.id)).toEqual(['b']);
  });

  it('prunes done rows after they linger, never failed ones', () => {
    let q = enqueue(enqueue([], item('a')), item('b'));
    q = finished(start(q, 'a'), 'a', { summary: summary() }, 0);
    q = finished(start(q, 'b'), 'b', { error: 'x' }, 0);
    expect(prune(q, LINGER_MS - 1).map((x) => x.id)).toEqual(['a', 'b']);
    expect(prune(q, LINGER_MS).map((x) => x.id)).toEqual(['b']);
    expect(clearFinished(q)).toEqual([]);
  });

  it('keeps the summary of a batch that stopped on an error, and fails the row', () => {
    let q = start(enqueue([], item('a')), 'a');
    q = finished(q, 'a', { summary: summary({ files: 2, resumable: 1, failed: 'the connection went away' }) }, 1000);
    expect(q[0].status).toBe('failed');
    expect(q[0].error).toBe('the connection went away');
    // Without the summary the row could not offer to continue what it kept.
    expect(q[0].summary?.resumable).toBe(1);
  });

  it('keeps a row that left an unfinished file, however long it lingers', () => {
    let q = start(enqueue(enqueue([], item('a')), item('b')), 'a');
    q = finished(q, 'a', { summary: summary({ cancelled: true, resumable: 1 }) }, 1000);
    q = start(q, 'b');
    q = finished(q, 'b', { summary: summary({ cancelled: true }) }, 1000);
    const left = prune(q, 1000 + LINGER_MS + 1).map((r) => r.id);
    expect(left).toEqual(['a']);
  });

  it('knows which rows can be continued', () => {
    const settled = finished(start(enqueue([], item('a')), 'a'), 'a', { summary: summary({ resumable: 1 }) }, 1000);
    expect(resumable(settled[0])).toBe(true);
    expect(resumable(start(enqueue([], item('b')), 'b')[0])).toBe(false);
    const nothing = finished(start(enqueue([], item('c')), 'c'), 'c', { summary: summary() }, 1000);
    expect(resumable(nothing[0])).toBe(false);
  });

  it('puts a row back in the queue to be continued, carrying nothing with it', () => {
    let q = start(enqueue([], item('a')), 'a');
    q = progressed(q, progress('a', 5), 1000);
    q = finished(q, 'a', { summary: summary({ cancelled: true, resumable: 1 }) }, 1000);
    q = requeue(q, 'a');
    expect(q[0].status).toBe('queued');
    expect(q[0].resume).toBe(true);
    expect(q[0].progress).toBeNull();
    expect(q[0].summary).toBeNull();
    expect(q[0].error).toBeNull();
    expect(nextToRun(q)?.id).toBe('a');
  });
});
