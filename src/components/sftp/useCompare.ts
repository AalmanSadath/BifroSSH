import { useState } from 'react';
import * as ipc from '../../ipc';
import type { FileEntry, TreeDiff } from '../../types';
import { diffSummary, isIdentical } from '../../compare';
import type { Pane } from './usePane';

/** How long a comparison runs before it is worth a dialog of its own. */
const COMPARE_DIALOG_DELAY_MS = 500;

/** A comparison of a directory with the one open in the other pane, and its dialog's state. */
export function useCompare() {
  // A comparison in flight or finished: its id is what cancels it, and the
  // diff is null until it comes back. `waited` turns on once it has run long
  // enough to be worth a dialog: a comparison of two small folders answers
  // in the notice before a modal would be read, and one that opened and shut
  // again looks like a fault rather than an answer.
  const [comparing, setComparing] = useState<{ id: string; left: string; right: string; diff: TreeDiff | null; waited: boolean } | null>(null);

  /**
   * Compares `entry` with the directory the other pane is showing.
   *
   * Nothing is copied and nothing is written: the two trees are walked, the
   * pairs that match on size are hashed, and what differs is listed. An
   * identical pair says so in the pane's notice rather than opening a modal
   * with nothing in it.
   */
  async function compareWith(pane: Pane, other: Pane, entry: FileEntry) {
    const id = crypto.randomUUID();
    const right = other.listing.path;
    setComparing({ id, left: entry.path, right, diff: null, waited: false });
    // Long enough that a quick answer never flashes a dialog, short enough
    // that a slow one does not look like nothing happened.
    const slow = setTimeout(() => {
      setComparing((c) => (c && c.id === id && c.diff === null ? { ...c, waited: true } : c));
    }, COMPARE_DIALOG_DELAY_MS);
    try {
      const diff = await ipc.sftpCompareTrees(
        id,
        pane.mode === 'local' ? null : pane.requireSid(),
        entry.path,
        other.mode === 'local' ? null : other.requireSid(),
        right,
      );
      pane.say(diffSummary(diff));
      if (isIdentical(diff)) setComparing(null);
      else setComparing((c) => (c && c.id === id ? { ...c, diff } : c));
    } catch (e) {
      setComparing(null);
      pane.fail(String(e));
    } finally {
      clearTimeout(slow);
    }
  }

  return {
    /** Only once there is something to read, or once it has taken long enough to be worth saying it is still going. */
    shown: comparing && (comparing.diff !== null || comparing.waited) ? comparing : null,
    compareWith,
    cancel: () => { if (comparing) ipc.sftpCancelTransfer(comparing.id).catch(() => {}); },
    close: () => setComparing(null),
  };
}
