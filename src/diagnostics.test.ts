import { describe, expect, it } from 'vitest';
import { withError, type DiagError } from './diagnostics';

const err = (at: number, message: string, where = 'banner'): DiagError => ({ at, where, message });

describe('withError', () => {
  it('keeps errors in the order they happened', () => {
    const list = withError(withError([], err(1, 'first')), err(2, 'second'));
    expect(list.map((e) => e.message)).toEqual(['first', 'second']);
  });

  it('drops the oldest past the cap', () => {
    let list: DiagError[] = [];
    for (let i = 0; i < 5; i++) list = withError(list, err(i, `e${i}`), 3);
    expect(list.map((e) => e.message)).toEqual(['e2', 'e3', 'e4']);
  });

  it('folds a repeat into the last entry, keeping its newer time', () => {
    const list = withError(withError([], err(1, 'refused')), err(9, 'refused'));
    expect(list).toEqual([err(9, 'refused')]);
  });

  it('keeps a repeat that came from somewhere else, or after something else', () => {
    const fromTab = withError([err(1, 'refused')], err(2, 'refused', 'tab'));
    expect(fromTab).toHaveLength(2);
    const between = withError([err(1, 'refused'), err(2, 'other')], err(3, 'refused'));
    expect(between).toHaveLength(3);
  });
});
