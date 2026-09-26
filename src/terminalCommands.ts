/**
 * Follows the shell's prompt in a live terminal: where typing starts, and
 * what was typed once a command starts running.
 *
 * Driven by the OSC 133 marks the shell integration sends. B, the end of the
 * prompt, says where the command line starts; C says it has been entered.
 * A shell still running the snippet from before B existed sends only A, and
 * then the first key pressed after it is taken as the start instead, which is
 * right unless the user moves the cursor into the prompt before typing.
 */

import type { IMarker, Terminal } from '@xterm/xterm';
import type { MarkKind } from './activity';
import { readCommand, worthRemembering } from './commandHistory';

export interface CommandTracker {
  /** Feed every mark the shell sends. */
  mark(kind: MarkKind): void;
  /** Where the command line being typed starts, or null when not at a prompt. */
  typedFrom(): { row: number; column: number } | null;
  dispose(): void;
}

export function attachCommandTracker(term: Terminal, onCommand: (command: string) => void): CommandTracker {
  let start: { marker: IMarker; column: number } | null = null;
  /** After a prompt with no B: the next key says where typing starts. */
  let awaitingKey = false;

  const drop = () => {
    start?.marker.dispose();
    start = null;
  };

  const startHere = () => {
    const buf = term.buffer.active;
    if (buf.type !== 'normal') return;
    drop();
    const marker = term.registerMarker(0);
    if (marker) start = { marker, column: buf.cursorX };
  };

  const keys = term.onKey(() => {
    if (awaitingKey && !start) startHere();
    awaitingKey = false;
  });

  return {
    mark(kind) {
      switch (kind) {
        case 'prompt':
          drop();
          awaitingKey = true;
          break;
        case 'input':
          // Called while the sequence is parsed, so the cursor is exactly at
          // the end of the prompt.
          startHere();
          awaitingKey = false;
          break;
        case 'output': {
          const buf = term.buffer.active;
          if (start && start.marker.line >= 0 && buf.type === 'normal') {
            const typed = readCommand(
              {
                text: (row, column) => buf.getLine(row)?.translateToString(false, column),
                wrapped: (row) => buf.getLine(row)?.isWrapped ?? false,
              },
              start.marker.line,
              start.column,
            );
            if (worthRemembering(typed)) onCommand(typed.trim());
          }
          drop();
          awaitingKey = false;
          break;
        }
        case 'done':
          break;
      }
    },
    typedFrom() {
      if (!start || start.marker.line < 0) return null;
      return { row: start.marker.line, column: start.column };
    },
    dispose() {
      keys.dispose();
      drop();
    },
  };
}
