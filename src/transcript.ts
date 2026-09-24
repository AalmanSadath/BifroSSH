/**
 * A tab's scrollback as plain text.
 *
 * Read from the terminal's own buffer rather than from the bytes that
 * arrived, so what comes out is what is on screen: escape sequences already
 * applied, colours gone, and a line the server redrew counted once. Pure over
 * the little of xterm's buffer API it needs, so it has tests without a
 * terminal.
 */

/** As much of an xterm buffer line as this reads. */
export interface BufferLineLike {
  /** True when this line is the continuation of the one above it. */
  isWrapped: boolean;
  translateToString(trimRight?: boolean): string;
}

/** As much of an xterm buffer as this reads. */
export interface BufferLike {
  /** Rows, scrollback included. */
  length: number;
  getLine(index: number): BufferLineLike | undefined;
}

/**
 * Every row from the start of the scrollback, with wrapped rows joined back
 * onto the line they belong to.
 *
 * A terminal stores a long line as however many rows it took to draw, so
 * copying row by row would put a newline wherever the window happened to be
 * narrow, which is not where the output had one.
 */
export function transcriptLines(buffer: BufferLike): string[] {
  const lines: string[] = [];
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    // Trailing spaces go, except where the line continues below: a row that
    // wrapped mid-space would otherwise lose it and run two words together.
    const continues = buffer.getLine(i + 1)?.isWrapped ?? false;
    const text = line.translateToString(!continues);
    if (line.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += text;
    } else {
      lines.push(text);
    }
  }
  return lines;
}

/**
 * The lines as a file: blank rows below the last output dropped, and one
 * newline at the end.
 *
 * A terminal is a fixed number of rows whether or not anything has been
 * written to them, so a session that printed three lines still has a buffer
 * full of empty ones, and a transcript that kept them would be mostly page.
 */
export function transcriptText(lines: string[]): string {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === '') end--;
  if (end === 0) return '';
  return `${lines.slice(0, end).join('\n')}\n`;
}

/**
 * A file name for the transcript: the host, then when it was taken.
 *
 * The host's name is free text and goes into a path, so anything that is not
 * a letter, digit, dash or dot becomes an underscore, the way session logs
 * are named.
 */
export function transcriptName(serverName: string, at: Date): string {
  const label = safeLabel(serverName);
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `${label}_${stamp}.txt`;
}

function safeLabel(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9.-]/g, '_').replace(/^[.]+/, '_').slice(0, 40);
  return cleaned === '' ? 'session' : cleaned;
}
