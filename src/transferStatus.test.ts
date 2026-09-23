import { describe, expect, it } from 'vitest';
import { describeTransfer, statusLine } from './transferStatus';
import type { QueueItem } from './transferQueue';
import type { TransferProgress, TransferSummary } from './types';

const summary = (over: Partial<TransferSummary> = {}): TransferSummary =>
  ({ files: 1, directories: 0, skipped_symlinks: 0, skipped_existing: 0, renamed: 0, cancelled: false, resumed: 0, mismatched: [], resumable: 0, landed: null, verified: 0, failed: null, ...over });

const progress = (over: Partial<TransferProgress> = {}) =>
  ({ transfer_id: 'a', file_name: 'big.bin', transferred: 0, total: 1000, resumed_from: 0, file_index: 1, file_count: 1, ...over });

function running(p: Partial<TransferProgress>, startTime = 0, at = 1000): QueueItem {
  return {
    id: 'a', name: 'big.bin', target: 'right', destination: 'pi',
    status: 'running',
    progress: { ...progress(p), startTime, at },
    error: null, summary: null, endedAt: null, cancelling: false, resume: false,
  };
}

describe('statusLine', () => {
  it('counts only the bytes this attempt carried towards the rate', () => {
    // 900 of 1000 were already there; 100 moved in one second.
    const row = running({ transferred: 1000, resumed_from: 900 });
    const { text, pct } = statusLine(row, 1000);
    expect(pct).toBe(100);
    expect(text).toContain('100 B/s');
    expect(text).not.toContain('1000 B/s');
  });

  it('measures the bar against the whole file, resumed bytes and all', () => {
    const { pct } = statusLine(running({ transferred: 500, resumed_from: 400 }), 1000);
    expect(pct).toBe(50);
  });

  it('reports silence rather than a rate nothing is running at', () => {
    const row = running({ transferred: 500 }, 0, 0);
    expect(statusLine(row, 11_000).text).toContain('stalled for 11s');
  });

  it('says bytes and a rate for a stream whose size nobody knows', () => {
    const { text, pct } = statusLine(running({ transferred: 2048, total: 0 }), 1000);
    expect(text).toContain('2.0 KB');
    expect(pct).toBe(0);
  });

  it('names each settled state without touching the progress', () => {
    const row = running({});
    expect(statusLine({ ...row, status: 'queued' }, 1000).text).toBe('Waiting');
    expect(statusLine({ ...row, status: 'done' }, 1000).text).toBe('Done');
    expect(statusLine({ ...row, status: 'cancelled' }, 1000).text).toBe('Stopped');
    expect(statusLine({ ...row, status: 'failed', error: 'no space' }, 1000).text).toBe('no space');
    expect(statusLine({ ...row, cancelling: true }, 1000).text).toBe('Stopping…');
  });
});

describe('describeTransfer', () => {
  it('says nothing about a transfer that did what was asked', () => {
    expect(describeTransfer(summary())).toBeNull();
  });

  it('counts resumed files that were read back, and the ones that did not match', () => {
    expect(describeTransfer(summary({ resumed: 1 })))
      .toBe('Resumed 1 file and read it back whole.');
    expect(describeTransfer(summary({ resumed: 3, mismatched: ['a', 'b'] })))
      .toBe('Resumed 1 file and read it back whole. 2 resumed files do not match the original.');
  });

  it('leaves out the resumed line when every resumed file was wrong', () => {
    expect(describeTransfer(summary({ resumed: 1, mismatched: [''] })))
      .toBe('1 resumed file does not match the original.');
  });

  it('says what was kept to resume', () => {
    expect(describeTransfer(summary({ files: 2, cancelled: true, resumable: 1 })))
      .toBe('Stopped after 2 files. Kept 1 unfinished file to resume.');
  });
});
