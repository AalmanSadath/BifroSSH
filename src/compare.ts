/**
 * Reading the result of a folder comparison. Pure, so the dialog and the
 * notice cannot describe the same diff differently.
 */

import type { TreeDiff } from './types';

/** Whether the two folders hold the same files with the same contents. */
export function isIdentical(diff: TreeDiff): boolean {
  return diff.only_left.length === 0 && diff.only_right.length === 0 && diff.differing.length === 0;
}

/** How many files the comparison had something to say about. */
export function differenceCount(diff: TreeDiff): number {
  return diff.only_left.length + diff.only_right.length + diff.differing.length;
}

/** One sentence for the pane notice. */
export function diffSummary(diff: TreeDiff): string {
  if (isIdentical(diff)) {
    const n = diff.same;
    return diff.cancelled
      ? `Stopped. Nothing different in the ${n} ${n === 1 ? 'file' : 'files'} checked.`
      : `The same: ${n} ${n === 1 ? 'file' : 'files'}, byte for byte.`;
  }
  const parts: string[] = [`${diff.same} the same`];
  if (diff.differing.length > 0) parts.push(`${diff.differing.length} different`);
  if (diff.only_left.length > 0) parts.push(`${diff.only_left.length} only on the left`);
  if (diff.only_right.length > 0) parts.push(`${diff.only_right.length} only on the right`);
  return `${parts.join(', ')}.${diff.cancelled ? ' Stopped before the end.' : ''}`;
}

/** The three groups, in the order the dialog shows them. */
export function diffGroups(diff: TreeDiff): { title: string; files: string[] }[] {
  return [
    { title: 'Different content', files: diff.differing },
    { title: 'Only on the left', files: diff.only_left },
    { title: 'Only on the right', files: diff.only_right },
  ].filter((group) => group.files.length > 0);
}
