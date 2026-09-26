import { describe, expect, it } from 'vitest';
import { EMPTY_SELECTION, clickSelect, inOrder } from './selection';

const order = ['a', 'b', 'c', 'd', 'e'];
const plain = { shift: false, toggle: false };
const ctrl = { shift: false, toggle: true };
const shift = { shift: true, toggle: false };
const both = { shift: true, toggle: true };
const ids = (s: { selected: Set<string> }) => inOrder(order, s.selected);

describe('clickSelect', () => {
  it('selects only what a plain click lands on', () => {
    const one = clickSelect(order, EMPTY_SELECTION, 'b', plain);
    expect(ids(one)).toEqual(['b']);
    expect(ids(clickSelect(order, one, 'd', plain))).toEqual(['d']);
  });

  it('adds and removes one at a time with Ctrl', () => {
    let s = clickSelect(order, EMPTY_SELECTION, 'a', plain);
    s = clickSelect(order, s, 'c', ctrl);
    expect(ids(s)).toEqual(['a', 'c']);
    s = clickSelect(order, s, 'a', ctrl);
    expect(ids(s)).toEqual(['c']);
  });

  it('selects the run between the anchor and a Shift-click, either way round', () => {
    const at = clickSelect(order, EMPTY_SELECTION, 'b', plain);
    expect(ids(clickSelect(order, at, 'd', shift))).toEqual(['b', 'c', 'd']);
    const up = clickSelect(order, clickSelect(order, EMPTY_SELECTION, 'd', plain), 'a', shift);
    expect(ids(up)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('measures a second Shift-click from the same anchor', () => {
    let s = clickSelect(order, EMPTY_SELECTION, 'c', plain);
    s = clickSelect(order, s, 'e', shift);
    s = clickSelect(order, s, 'a', shift);
    expect(ids(s)).toEqual(['a', 'b', 'c']);
  });

  it('adds a range to what was there when Ctrl is held too', () => {
    let s = clickSelect(order, EMPTY_SELECTION, 'a', plain);
    s = clickSelect(order, s, 'd', ctrl);
    s = clickSelect(order, s, 'e', both);
    expect(ids(s)).toEqual(['a', 'd', 'e']);
  });

  it('treats a Shift-click with nothing to measure from as a plain one', () => {
    expect(ids(clickSelect(order, EMPTY_SELECTION, 'c', shift))).toEqual(['c']);
    // An anchor that has since been filtered out of view.
    const stale = { selected: new Set(['z']), anchor: 'z' };
    expect(ids(clickSelect(order, stale, 'c', shift))).toEqual(['c']);
  });
});

describe('inOrder', () => {
  it('follows the order shown, not the order of selecting', () => {
    expect(inOrder(order, new Set(['e', 'a', 'c']))).toEqual(['a', 'c', 'e']);
  });
});
