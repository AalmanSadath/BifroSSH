/**
 * What a transfer row says while it runs, and what a finished one is worth
 * saying afterwards. Pure, and out of the panel, because the arithmetic was
 * the part worth testing and a `.tsx` is the one place tests do not reach.
 */

import type { QueueItem } from './transferQueue';
import type { TransferSummary } from './types';

/** Reported as silence rather than a stale rate; see `statusLine`. */
export const STALL_AFTER_MS = 10_000;

export function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  if (bytesPerSec >= 1024 * 1024) return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${Math.round(bytesPerSec)} B/s`;
}

/**
 * The line under a row's name, and how far its bar is filled.
 *
 * The rate counts only the bytes this attempt carried. A file resumed at 90%
 * has nine tenths of itself at the destination already, and counting those
 * against the two seconds since the resume began reports a speed nothing ever
 * ran at and an estimate of no time at all. The percentage is the position in
 * the file, resumed bytes included, because that is what the bar means.
 *
 * Silence is reported rather than a stale rate: the backend gives a stalled
 * transfer a minute before it calls the connection dead, and saying nothing
 * for that minute made a dead transfer look like a working one. Ten seconds
 * rather than five, since one 128 KB chunk takes 6.4s at 20 KB/s and a
 * shorter window would call a slow link stalled.
 */
export function statusLine(row: QueueItem, now: number): { text: string; pct: number } {
  const p = row.progress;
  if (row.status === 'queued') return { text: 'Waiting', pct: 0 };
  if (row.status === 'done') return { text: 'Done', pct: 0 };
  if (row.status === 'cancelled') return { text: 'Stopped', pct: 0 };
  if (row.status === 'failed') return { text: row.error ?? 'Failed', pct: 0 };
  if (!p) return { text: row.cancelling ? 'Stopping…' : 'Starting…', pct: 0 };

  const elapsed = (now - p.startTime) / 1000;
  const moved = Math.max(0, p.transferred - p.resumed_from);
  const speed = elapsed > 0.1 ? moved / elapsed : 0;
  const silentFor = Math.round((now - p.at) / 1000);
  const stalled = now - p.at >= STALL_AFTER_MS;
  if (row.cancelling) return { text: 'Stopping…', pct: percent(p.transferred, p.total) };

  // A stream whose size nobody knows yet: a compressed download. Bytes so
  // far and a rate are all there is to say.
  if (p.total === 0) {
    const text = stalled
      ? `${formatSize(p.transferred)} · stalled for ${silentFor}s`
      : `${formatSize(p.transferred)} · ${formatSpeed(speed)}`;
    return { text, pct: 0 };
  }

  const pct = percent(p.transferred, p.total);
  const remaining = speed > 0 ? (p.total - p.transferred) / speed : null;
  const eta = remaining !== null
    ? remaining < 60 ? `${Math.ceil(remaining)}s` : `${Math.ceil(remaining / 60)}m`
    : '…';
  const count = p.file_count > 1 ? `${p.file_index}/${p.file_count} · ` : '';
  const text = stalled
    ? `${count}${pct}% · stalled for ${silentFor}s`
    : `${count}${pct}% · ${formatSpeed(speed)} · ETA ${eta}`;
  return { text, pct };
}

function percent(transferred: number, total: number): number {
  return total > 0 ? Math.min(100, Math.round((transferred / total) * 100)) : 0;
}

/**
 * What a finished transfer is worth saying, or nothing.
 *
 * The backend has always counted these and the panel used to throw the answer
 * away, so a batch that quietly copied less than was asked for looked
 * identical to one that copied all of it. Only the surprises are reported: a
 * transfer that did what was asked needs no announcement.
 */
export function describeTransfer(s: TransferSummary): string | null {
  const parts: string[] = [];
  if (s.verified > 0) {
    parts.push(`Verified ${s.verified} ${s.verified === 1 ? 'file' : 'files'}.`);
  }
  if (s.cancelled) {
    parts.push(`Stopped after ${s.files} ${s.files === 1 ? 'file' : 'files'}.`);
  }
  if (s.skipped_symlinks > 0) {
    const n = s.skipped_symlinks;
    parts.push(`${n} ${n === 1 ? 'symlink was' : 'symlinks were'} not copied.`);
  }
  if (s.skipped_existing > 0) {
    parts.push(`Skipped ${s.skipped_existing} that already existed.`);
  }
  if (s.renamed > 0) {
    const n = s.renamed;
    parts.push(`Kept ${n} ${n === 1 ? 'copy' : 'copies'} beside what was there.`);
  }
  const checked = s.resumed - s.mismatched.length;
  if (checked > 0) {
    parts.push(`Resumed ${checked} ${checked === 1 ? 'file' : 'files'} and read ${checked === 1 ? 'it' : 'them'} back whole.`);
  }
  if (s.mismatched.length > 0) {
    const n = s.mismatched.length;
    parts.push(`${n} resumed ${n === 1 ? 'file does' : 'files do'} not match the original.`);
  }
  if (s.resumable > 0) {
    const n = s.resumable;
    parts.push(`Kept ${n} unfinished ${n === 1 ? 'file' : 'files'} to resume.`);
  }
  return parts.length > 0 ? parts.join(' ') : null;
}
