import { describe, expect, it } from 'vitest';
import { MIN_PANE_PCT, evenAt, evenWidths, resizeAt, widthAt } from './paneSizes';

describe('evenWidths', () => {
  it('divides the row, and has nothing to divide for no panes', () => {
    expect(evenWidths(2)).toEqual([50, 50]);
    expect(evenWidths(4)).toEqual([25, 25, 25, 25]);
    expect(evenWidths(0)).toEqual([]);
  });
});

describe('widthAt', () => {
  it('takes the even share until someone has dragged something', () => {
    expect(widthAt([], 0, 2)).toBe(50);
    expect(widthAt([70, 30], 1, 2)).toBe(30);
  });

  it('ignores widths belonging to a different number of panes', () => {
    expect(widthAt([70, 30], 2, 3)).toBeCloseTo(100 / 3);
  });
});

describe('evenAt', () => {
  it('shares the pair either side of the boundary, and leaves the rest alone', () => {
    expect(evenAt([70, 30], 1)).toEqual([50, 50]);
    expect(evenAt([20, 60, 20], 2)).toEqual([20, 40, 40]);
    expect(evenAt([20, 60, 20], 1)).toEqual([40, 40, 20]);
  });

  it('has no boundary to the left of the first pane, or past the last', () => {
    expect(evenAt([70, 30], 0)).toEqual([70, 30]);
    expect(evenAt([70, 30], 2)).toEqual([70, 30]);
  });
});

describe('resizeAt', () => {
  it('moves one boundary and leaves the row the same size', () => {
    const next = resizeAt([50, 50], 1, 10);
    expect(next).toEqual([60, 40]);
    expect(next[0] + next[1]).toBe(100);
  });

  it('touches only the two panes either side of the boundary', () => {
    expect(resizeAt([25, 25, 50], 2, 10)).toEqual([25, 35, 40]);
  });

  it('stops at the floor rather than collapsing a pane', () => {
    expect(resizeAt([50, 50], 1, 95)).toEqual([100 - MIN_PANE_PCT, MIN_PANE_PCT]);
    expect(resizeAt([50, 50], 1, -95)).toEqual([MIN_PANE_PCT, 100 - MIN_PANE_PCT]);
  });

  it('has no boundary to the left of the first pane, or past the last', () => {
    expect(resizeAt([50, 50], 0, 10)).toEqual([50, 50]);
    expect(resizeAt([50, 50], 2, 10)).toEqual([50, 50]);
  });
});
