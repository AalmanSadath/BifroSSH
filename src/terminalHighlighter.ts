/**
 * Draws keyword highlighting onto a live terminal.
 *
 * Each row that has a match gets a marker, which moves with the row as output
 * scrolls, and one decoration per match that recolours the text in place. The
 * output itself is never touched: a copy, a transcript and a search all see the
 * bytes the server sent.
 *
 * Only the rows that changed are looked at. A pass runs once per animation
 * frame while output arrives, over the rows written since the last pass and
 * the rows on screen; a row whose text is what it was last time is skipped. A
 * row that scrolls off the end of the scrollback takes its marker, and so its
 * decorations, with it.
 */

import type { IDecoration, IMarker, Terminal } from '@xterm/xterm';
import { matchesIn, type CompiledRule } from './highlight';

export interface HighlightState {
  enabled: boolean;
  rules: CompiledRule[];
  /** Colour name to `#rrggbb`, from the tab's theme. */
  palette: Record<string, string | undefined>;
}

export interface Highlighter {
  /** Forget everything drawn and look again, after the rules or the theme change. */
  refresh(): void;
  dispose(): void;
}

/** Rows looked at in one pass at most, so a large paste cannot stall a frame. */
const MAX_ROWS_PER_PASS = 2000;

interface Row {
  marker: IMarker;
  text: string;
  decorations: IDecoration[];
}

export function attachHighlighter(term: Terminal, state: () => HighlightState): Highlighter {
  /** Rows that currently carry decorations. Rows with none are not kept. */
  const rows = new Set<Row>();
  /** The last row the previous pass reached, so the next starts there. */
  let scannedTo = 0;
  let frame = 0;

  const forget = (row: Row) => {
    row.decorations.forEach((d) => d.dispose());
    row.marker.dispose();
    rows.delete(row);
  };

  const clear = () => {
    [...rows].forEach(forget);
  };

  const pass = () => {
    frame = 0;
    const buf = term.buffer.active;
    // A full-screen program draws its own colours, and xterm will not
    // decorate the alternate buffer anyway.
    if (buf.type !== 'normal') return;
    const { enabled, rules, palette } = state();
    if (!enabled || rules.length === 0) {
      clear();
      return;
    }

    const cursorRow = buf.baseY + buf.cursorY;
    const from = Math.max(0, Math.min(scannedTo, buf.viewportY), cursorRow - MAX_ROWS_PER_PASS);
    const to = Math.max(cursorRow, buf.viewportY + term.rows - 1);
    scannedTo = cursorRow;

    const byLine = new Map<number, Row>();
    rows.forEach((row) => byLine.set(row.marker.line, row));

    for (let y = from; y <= to && y < buf.length; y++) {
      const read = readRow(term, y);
      if (!read) continue;
      const existing = byLine.get(y);
      if (existing?.text === read.text) continue;
      if (existing) forget(existing);

      const matches = matchesIn(read.text, rules);
      if (matches.length === 0) continue;
      const marker = term.registerMarker(y - cursorRow);
      if (!marker) continue;
      const row: Row = { marker, text: read.text, decorations: [] };
      for (const m of matches) {
        const color = palette[m.color];
        if (!color || !/^#[0-9a-fA-F]{6}$/.test(color)) continue;
        const x = read.columns[m.start];
        const endCol = read.columns[m.start + m.length - 1];
        if (x === undefined || endCol === undefined) continue;
        const decoration = term.registerDecoration({
          marker,
          x,
          width: read.widths[m.start + m.length - 1] + endCol - x,
          foregroundColor: color,
          layer: 'top',
        });
        if (decoration) row.decorations.push(decoration);
      }
      if (row.decorations.length === 0) {
        marker.dispose();
        continue;
      }
      rows.add(row);
      // Trimmed off the top of the scrollback: the row is gone, so is this.
      marker.onDispose(() => {
        row.decorations.forEach((d) => d.dispose());
        rows.delete(row);
      });
    }
  };

  const schedule = () => {
    if (frame === 0) frame = requestAnimationFrame(pass);
  };

  const subscriptions = [
    term.onWriteParsed(schedule),
    // Scrolled up past what the last busy pass reached.
    term.onScroll(schedule),
  ];

  return {
    refresh() {
      clear();
      scannedTo = 0;
      schedule();
    },
    dispose() {
      if (frame !== 0) cancelAnimationFrame(frame);
      subscriptions.forEach((s) => s.dispose());
      clear();
    },
  };
}

/**
 * A row's text, with the terminal column each character sits in.
 *
 * The two differ as soon as a row holds a wide character: a CJK character or
 * an emoji is one character of text and two columns on screen, and every match
 * after it would be drawn one column short per wide character before it.
 */
function readRow(
  term: Terminal,
  y: number,
): { text: string; columns: number[]; widths: number[] } | null {
  const line = term.buffer.active.getLine(y);
  if (!line) return null;
  let text = '';
  const columns: number[] = [];
  const widths: number[] = [];
  const cell = term.buffer.active.getNullCell();
  for (let x = 0; x < line.length; x++) {
    line.getCell(x, cell);
    const width = cell.getWidth();
    // The right half of a wide character, already counted with its left.
    if (width === 0) continue;
    const chars = cell.getChars() || ' ';
    for (let i = 0; i < chars.length; i++) {
      columns.push(x);
      widths.push(width);
    }
    text += chars;
  }
  const trimmed = text.replace(/\s+$/, '');
  return {
    text: trimmed,
    columns: columns.slice(0, trimmed.length),
    widths: widths.slice(0, trimmed.length),
  };
}
