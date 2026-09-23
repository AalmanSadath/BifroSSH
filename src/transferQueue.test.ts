import { describe, expect, it } from 'vitest';
import { LINGER_MS, cancel, clearFinished, enqueue, finished, nextToRun, progressed, prune, start } from './transferQueue';
import type { TransferProgress, TransferSummary } from './types';

const item = (id: string) => ({ id, name: id, target: 'right' as const, destination: 'pi' });
const summary = (over: Partial<TransferSummary> = {}): TransferSummary =>
  ({ files: 1, directories: 0, skipped_symlinks: 0, skipped_existing: 0, renamed: 0, cancelled: false, landed: null, verified: 0, ...over });
const progress = (id: string, transferred: number): TransferProgress =>
  ({ transfer_id: id, file_name: 'f', transferred, total: 10, file_index: 1, file_count: 1 });

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
});
