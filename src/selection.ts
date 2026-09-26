/**
 * Click-to-select over a list, the way a file manager does it.
 *
 * Pure, over ids and the order they are shown in, so it is tested without a
 * page. The order matters: a Shift-click selects what lies between two cards
 * on screen, which with groups and a filter is not what lies between them in
 * the saved list.
 */

export interface Selection {
  selected: Set<string>;
  /** Where the next Shift-click measures from; moved by a plain or Ctrl click. */
  anchor: string | null;
}

export const EMPTY_SELECTION: Selection = { selected: new Set(), anchor: null };

export interface ClickKeys {
  shift: boolean;
  /** Ctrl, or Cmd on a Mac. */
  toggle: boolean;
}

/** The selection after `id` was clicked with these keys held. */
export function clickSelect(order: string[], current: Selection, id: string, keys: ClickKeys): Selection {
  const anchorAt = current.anchor === null ? -1 : order.indexOf(current.anchor);
  const at = order.indexOf(id);

  if (keys.shift && anchorAt !== -1 && at !== -1) {
    const [lo, hi] = anchorAt < at ? [anchorAt, at] : [at, anchorAt];
    const range = order.slice(lo, hi + 1);
    // Ctrl as well adds the range to what was there; Shift alone replaces it.
    // The anchor stays put, so a second Shift-click re-measures from it.
    const selected = keys.toggle ? new Set([...current.selected, ...range]) : new Set(range);
    return { selected, anchor: current.anchor };
  }
  if (keys.toggle) {
    const selected = new Set(current.selected);
    if (selected.has(id)) selected.delete(id);
    else selected.add(id);
    return { selected, anchor: id };
  }
  return { selected: new Set([id]), anchor: id };
}

/** The selected ids in the order they are shown, which is the order to act on them. */
export function inOrder(order: string[], selected: Set<string>): string[] {
  return order.filter((id) => selected.has(id));
}
