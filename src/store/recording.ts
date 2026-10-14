import * as ipc from '../ipc';
import { terminalFor } from '../terminalRegistry';
import { screenSnapshot } from '../screenSnapshot';

/**
 * Asks the backend to start or stop recording a session, with the size and
 * the screen of the tab's terminal as they are now.
 */
export function startOrStopRecording(sessionId: string, tabId: string, label: string, on: boolean): Promise<string | null> {
  const term = terminalFor(tabId);
  const buf = term?.buffer.active;
  const screen = on && term && buf
    ? screenSnapshot({
      rows: term.rows,
      top: buf.baseY,
      cursorX: buf.cursorX,
      cursorY: buf.cursorY,
      line: (row) => buf.getLine(row)?.translateToString(true),
    })
    : null;
  return ipc.sshSetRecording(sessionId, label, on, term?.cols ?? 80, term?.rows ?? 24, screen || null);
}
