/**
 * How a split divides its row. Pure, so the arithmetic of a drag can be
 * tested without a mouse.
 *
 * Widths are percentages of the row and always sum to 100. An empty list
 * means nobody has dragged anything, and the panes share the row evenly.
 */

/** The narrowest a pane can be dragged; below this a terminal shows nothing. */
export const MIN_PANE_PCT = 10;

/** Equal shares for `count` panes. */
export function evenWidths(count: number): number[] {
  return count > 0 ? Array.from({ length: count }, () => 100 / count) : [];
}

/** The width of pane `index` of `count`: its own, or the even share. */
export function widthAt(widths: number[], index: number, count: number): number {
  return widths.length === count ? widths[index] : 100 / count;
}

/**
 * Splits the pair either side of the boundary at `index` evenly between
 * them, leaving every other pane where it is.
 *
 * A double-click on one divider is about that divider: with three panes,
 * evening the whole row would move a boundary the user was not touching.
 */
export function evenAt(widths: number[], index: number): number[] {
  if (index <= 0 || index >= widths.length) return widths;
  const share = (widths[index - 1] + widths[index]) / 2;
  const next = [...widths];
  next[index - 1] = share;
  next[index] = share;
  return next;
}

/**
 * Moves the boundary to the left of pane `index` by `deltaPct`.
 *
 * Zero-sum against the pane before it, so the panes either side of the
 * boundary change and the rest of the row stays put, and clamped so neither
 * can be squeezed below the floor. The SFTP column resizer works the same
 * way; a table and a split have the same problem.
 */
export function resizeAt(widths: number[], index: number, deltaPct: number): number[] {
  if (index <= 0 || index >= widths.length) return widths;
  const before = widths[index - 1];
  const here = widths[index];
  // The move the floors allow, which may be less than the one asked for.
  const room = Math.max(-(before - MIN_PANE_PCT), Math.min(here - MIN_PANE_PCT, deltaPct));
  const next = [...widths];
  next[index - 1] = before + room;
  next[index] = here - room;
  return next;
}
