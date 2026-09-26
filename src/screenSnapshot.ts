/**
 * What a terminal shows right now, as text a fresh terminal can be fed to
 * show the same: the visible rows, then the cursor put back where it was.
 *
 * Written at the start of a recording, so playback opens on the screen the
 * recording was started from rather than on a blank one that fills in only
 * as the host happens to redraw. Colours are not kept; the text is.
 */

export interface ScreenSource {
  rows: number;
  /** The first visible row, in buffer coordinates. */
  top: number;
  cursorX: number;
  cursorY: number;
  line(row: number): string | undefined;
}

export function screenSnapshot(src: ScreenSource): string {
  const lines: string[] = [];
  for (let i = 0; i < src.rows; i++) lines.push((src.line(src.top + i) ?? '').trimEnd());
  // Trailing blank rows add nothing, and a player at another size would
  // scroll on them.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) return '';
  return `${lines.join('\r\n')}\x1b[${src.cursorY + 1};${src.cursorX + 1}H`;
}
