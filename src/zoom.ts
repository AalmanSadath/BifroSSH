/**
 * Per-tab terminal font size. Pure, so the rules can be tested without a
 * terminal.
 */

/** The range the font size setting itself allows, and so the range a zoom allows. */
export const MIN_ZOOM = 8;
export const MAX_ZOOM = 32;

/** A font size held inside the range the settings input accepts. */
export function clampZoom(size: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(size)));
}

/**
 * How far a tab has been zoomed from the size it would otherwise have, for
 * the tooltip. Whole percent, and null when the tab is at that size, since
 * there is then nothing worth saying.
 */
export function zoomPercent(size: number | undefined, base: number): number | null {
  if (size === undefined || size === base || base <= 0) return null;
  return Math.round((size / base) * 100);
}
