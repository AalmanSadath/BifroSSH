import { describe, expect, it } from 'vitest';
import { batchSettled, countOf, record, shownPath, take, type Mismatch, type Pending } from './mismatches';
import { enqueue, finished, start } from './transferQueue';
import type { TransferSummary } from './types';

const mismatch = (over: Partial<Mismatch> = {}): Mismatch =>
  ({ jobId: 'a', name: 'tree', landed: '/dst/tree', rels: ['one.txt'], ...over });

const summary = (): TransferSummary =>
  ({ files: 1, directories: 0, skipped_symlinks: 0, skipped_existing: 0, renamed: 0, cancelled: false, resumed: 0, mismatched: [], resumable: 0, landed: null, verified: 0, failed: null });

const row = (id: string) => ({ id, name: id, target: 'right' as const, destination: 'pi' });

describe('mismatches', () => {
  it('gathers every row of a batch into one list', () => {
    let pending: Pending = {};
    pending = record(pending, 'drop', mismatch({ jobId: 'a' }));
    pending = record(pending, 'drop', mismatch({ jobId: 'b', rels: ['x', 'y'] }));
    expect(pending['drop'].map((m) => m.jobId)).toEqual(['a', 'b']);
    expect(countOf(pending['drop'])).toBe(3);
  });

  it('keeps one batch out of the dialog of another', () => {
    let pending: Pending = {};
    pending = record(pending, 'one', mismatch({ jobId: 'a' }));
    pending = record(pending, 'two', mismatch({ jobId: 'b' }));
    const { taken, rest } = take(pending, 'one');
    expect(taken.map((m) => m.jobId)).toEqual(['a']);
    expect(rest['two']).toHaveLength(1);
  });

  it('hands a batch over once, so the dialog cannot reopen on it', () => {
    const pending = record({}, 'drop', mismatch());
    const { rest } = take(pending, 'drop');
    expect(take(rest, 'drop').taken).toEqual([]);
  });

  it('waits while any row of the batch is queued or running', () => {
    let q = enqueue(enqueue([], row('a')), row('b'));
    const batchOf = () => 'drop';
    q = start(q, 'a');
    expect(batchSettled(q, batchOf, 'drop')).toBe(false);
    q = finished(q, 'a', { summary: summary() }, 1000);
    expect(batchSettled(q, batchOf, 'drop')).toBe(false);
    q = start(q, 'b');
    q = finished(q, 'b', { summary: summary() }, 1000);
    expect(batchSettled(q, batchOf, 'drop')).toBe(true);
    // A row of another drop still running is not this batch's business.
    expect(batchSettled(start(enqueue(q, row('c')), 'c'), () => 'other', 'drop')).toBe(true);
  });

  it('shows a single file under its own name, since it has no relative path', () => {
    const single = mismatch({ name: 'big.bin', rels: [''] });
    expect(shownPath(single, '')).toBe('big.bin');
    expect(shownPath(mismatch(), 'sub/one.txt')).toBe('sub/one.txt');
  });
});
