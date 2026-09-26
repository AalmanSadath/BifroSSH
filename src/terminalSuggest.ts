/**
 * The grey rest-of-a-command drawn after the cursor while typing at a prompt.
 *
 * Drawn as a decoration over the empty cells after the cursor, so nothing is
 * written into the terminal and the shell never sees it until it is accepted,
 * at which point it is sent exactly as if typed. Shown only while all of these
 * hold: the shell is at a prompt (the tracker knows where typing started),
 * the normal buffer is showing, the cursor is at the end of what has been
 * typed, and history has a command that starts with it.
 */

import type { IDecoration, IMarker, Terminal } from '@xterm/xterm';
import type { CommandTracker } from './terminalCommands';
import { suggestionFor } from './suggest';

export interface Suggester {
  /** The suggestion showing now, or null. */
  current(): string | null;
  /** Take it down, after it was accepted or when the settings change. */
  clear(): void;
  /** Look again, after history or the setting changed. */
  refresh(): void;
  dispose(): void;
}

export function attachSuggester(
  term: Terminal,
  tracker: CommandTracker,
  state: () => { enabled: boolean; history: string[] },
): Suggester {
  let shown: { marker: IMarker; decoration: IDecoration; row: number; x: number; text: string } | null = null;
  let frame = 0;

  const clear = () => {
    shown?.decoration.dispose();
    shown?.marker.dispose();
    shown = null;
  };

  const update = () => {
    frame = 0;
    const { enabled, history } = state();
    const buf = term.buffer.active;
    const from = tracker.typedFrom();
    if (!enabled || !from || buf.type !== 'normal') return clear();

    const cursorRow = buf.baseY + buf.cursorY;
    const typed = typedUpToCursor(term, from, cursorRow, buf.cursorX);
    if (typed === null || !nothingAfterCursor(term, cursorRow, buf.cursorX)) return clear();

    const rest = suggestionFor(typed, history);
    if (!rest) return clear();
    // What fits on this row; a suggestion that would wrap is cut at the edge.
    const text = rest.slice(0, term.cols - buf.cursorX);
    if (text === '') return clear();
    if (shown && shown.row === cursorRow && shown.x === buf.cursorX && shown.text === text) return;

    clear();
    const marker = term.registerMarker(0);
    if (!marker) return;
    const decoration = term.registerDecoration({ marker, x: buf.cursorX, width: text.length, layer: 'top' });
    if (!decoration) {
      marker.dispose();
      return;
    }
    decoration.onRender((el) => {
      el.classList.add('term-suggestion');
      el.textContent = text;
      el.style.fontFamily = term.options.fontFamily ?? 'monospace';
      el.style.fontSize = `${term.options.fontSize ?? 14}px`;
      el.style.lineHeight = el.style.height;
      // The theme's own text colour, dimmed by the class: the decoration
      // layer does not inherit the rows' colour, and a fixed grey would
      // vanish on a light theme.
      el.style.color = term.options.theme?.foreground ?? '#888888';
    });
    shown = { marker, decoration, row: cursorRow, x: buf.cursorX, text };
  };

  const schedule = () => {
    if (frame === 0) frame = requestAnimationFrame(update);
  };

  const subscriptions = [term.onWriteParsed(schedule), term.onCursorMove(schedule), term.onResize(schedule)];

  return {
    current: () => shown?.text ?? null,
    clear,
    refresh: schedule,
    dispose() {
      if (frame !== 0) cancelAnimationFrame(frame);
      subscriptions.forEach((s) => s.dispose());
      clear();
    },
  };
}

/**
 * What has been typed from the end of the prompt to the cursor, or null when
 * the cursor is not on the command line at all.
 */
function typedUpToCursor(
  term: Terminal,
  from: { row: number; column: number },
  cursorRow: number,
  cursorX: number,
): string | null {
  const buf = term.buffer.active;
  if (cursorRow < from.row) return null;
  if (cursorRow === from.row) {
    if (cursorX < from.column) return null;
    return buf.getLine(from.row)?.translateToString(false, from.column, cursorX) ?? null;
  }
  let out = buf.getLine(from.row)?.translateToString(false, from.column) ?? '';
  for (let row = from.row + 1; row <= cursorRow; row++) {
    const line = buf.getLine(row);
    // A row that did not wrap on from the last is not part of this command.
    if (!line?.isWrapped) return null;
    out += row === cursorRow ? line.translateToString(false, 0, cursorX) : line.translateToString(false);
  }
  return out;
}

/** Whether the cursor is at the end of the line, with nothing typed after it. */
function nothingAfterCursor(term: Terminal, cursorRow: number, cursorX: number): boolean {
  const buf = term.buffer.active;
  if (buf.getLine(cursorRow)?.translateToString(true, cursorX) !== '') return false;
  const next = buf.getLine(cursorRow + 1);
  return !(next?.isWrapped && next.translateToString(true) !== '');
}
