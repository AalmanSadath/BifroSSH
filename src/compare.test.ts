import { describe, expect, it } from 'vitest';
import { diffGroups, diffSummary, differenceCount, isIdentical } from './compare';
import type { TreeDiff } from './types';

const diff = (over: Partial<TreeDiff> = {}): TreeDiff => ({
  only_left: [],
  only_right: [],
  differing: [],
  same: 0,
  cancelled: false,
  hashed: 0,
  ...over,
});

describe('isIdentical', () => {
  it('is true only when no list has anything in it', () => {
    expect(isIdentical(diff({ same: 4, hashed: 4 }))).toBe(true);
    expect(isIdentical(diff({ differing: ['a'] }))).toBe(false);
    expect(isIdentical(diff({ only_right: ['a'] }))).toBe(false);
  });
});

describe('differenceCount', () => {
  it('counts across the three lists', () => {
    expect(differenceCount(diff({ differing: ['a'], only_left: ['b', 'c'], only_right: ['d'] }))).toBe(4);
  });
});

describe('diffSummary', () => {
  it('says so plainly when the two match', () => {
    expect(diffSummary(diff({ same: 3, hashed: 3 }))).toBe('The same: 3 files, byte for byte.');
    expect(diffSummary(diff({ same: 1, hashed: 1 }))).toContain('1 file,');
  });

  it('lists only the kinds of difference it found', () => {
    expect(diffSummary(diff({ same: 2, differing: ['a'] }))).toBe('2 the same, 1 different.');
    expect(diffSummary(diff({ same: 2, only_left: ['a'] }))).toBe('2 the same, 1 only on the left.');
  });

  it('admits when it was stopped part way', () => {
    expect(diffSummary(diff({ same: 2, cancelled: true }))).toContain('Stopped');
    expect(diffSummary(diff({ same: 2, differing: ['a'], cancelled: true }))).toContain('Stopped before the end');
  });
});

describe('diffGroups', () => {
  it('keeps the groups that have something in them, in reading order', () => {
    const groups = diffGroups(diff({ differing: ['a'], only_right: ['b'] }));
    expect(groups.map((g) => g.title)).toEqual(['Different content', 'Only on the right']);
    expect(groups[1].files).toEqual(['b']);
  });

  it('is empty for two folders that match', () => {
    expect(diffGroups(diff({ same: 3 }))).toEqual([]);
  });
});
