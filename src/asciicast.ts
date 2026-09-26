/**
 * Reading asciicast recordings for the player.
 *
 * Version 2 is what this app writes: a header line, then `[seconds, code,
 * data]` per event, the seconds counted from the start. Version 3, what
 * asciinema itself writes now, is read too: its header names the size under
 * `term`, and each event's time is the gap since the one before. Only output
 * (`o`) and resizes (`r`) matter to a player; input, markers and the rest
 * are skipped.
 */

export interface CastEvent {
  /** Seconds from the start. */
  t: number;
  kind: 'o' | 'r';
  data: string;
}

export interface Cast {
  cols: number;
  rows: number;
  title: string | null;
  events: CastEvent[];
  /** When the last event happens, in seconds. */
  duration: number;
}

export function parseCast(text: string): Cast {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  if (lines.length === 0) throw new Error('The file is empty.');

  let header: Record<string, unknown>;
  try {
    header = JSON.parse(lines[0]) as Record<string, unknown>;
  } catch {
    throw new Error('This is not an asciicast recording.');
  }
  if (typeof header !== 'object' || header === null || Array.isArray(header)) {
    throw new Error('This is not an asciicast recording.');
  }
  const version = header.version;
  if (version === 1) throw new Error('This is an asciicast v1 recording, which is not supported. Versions 2 and 3 are.');
  if (version !== 2 && version !== 3) throw new Error('This is not an asciicast recording.');

  const term = (header.term ?? {}) as Record<string, unknown>;
  const cols = positive(version === 2 ? header.width : term.cols) ?? 80;
  const rows = positive(version === 2 ? header.height : term.rows) ?? 24;
  const title = typeof header.title === 'string' ? header.title : null;

  const events: CastEvent[] = [];
  let clock = 0;
  for (const line of lines.slice(1)) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Array.isArray(event) || typeof event[0] !== 'number' || typeof event[2] !== 'string') continue;
    // v3 counts from the event before; v2 from the start. A recording that
    // runs backwards anywhere is played in order anyway.
    clock = version === 3 ? clock + Math.max(0, event[0]) : Math.max(clock, event[0]);
    if (event[1] === 'o' || event[1] === 'r') events.push({ t: clock, kind: event[1], data: event[2] });
  }
  return { cols, rows, title, events, duration: events.length > 0 ? events[events.length - 1].t : 0 };
}

function positive(n: unknown): number | null {
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;
}

/**
 * The same events with every pause longer than `max` seconds cut to `max`,
 * so a recording left running over lunch does not play the lunch.
 */
export function compressIdle(events: CastEvent[], max: number): CastEvent[] {
  let removed = 0;
  let last = 0;
  return events.map((e) => {
    const gap = e.t - last;
    last = e.t;
    if (gap > max) removed += gap - max;
    return { ...e, t: e.t - removed };
  });
}

/** How many events have happened by time `t`: the index of the first one still to come. */
export function eventsBy(events: CastEvent[], t: number): number {
  let lo = 0;
  let hi = events.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].t <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A resize event's `COLSxROWS`, or null for anything else. */
export function parseSize(data: string): { cols: number; rows: number } | null {
  const m = /^(\d+)x(\d+)$/.exec(data.trim());
  if (!m) return null;
  const [cols, rows] = [Number(m[1]), Number(m[2])];
  return cols >= 1 && rows >= 1 ? { cols, rows } : null;
}

/** `m:ss`, or `h:mm:ss` past an hour. */
export function clockTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const [h, m, sec] = [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60];
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/**
 * The host and the moment a recording started, from its file name.
 *
 * The backend names a recording `<label>_<YYYYMMDD-HHMMSS>_<id8>.cast`, the
 * stamp in UTC, so a list can say whose and when without opening each file.
 * A file named any other way is shown by its name and has no time.
 */
export function recordingName(fileName: string): { label: string; at: Date | null } {
  const stem = fileName.replace(/\.cast$/i, '');
  const m = /^(.*)_(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})_[0-9a-zA-Z-]{1,8}$/.exec(stem);
  if (!m) return { label: stem, at: null };
  const [y, mo, d, h, mi, s] = m.slice(2).map(Number);
  return { label: m[1].replace(/_/g, ' '), at: new Date(Date.UTC(y, mo - 1, d, h, mi, s)) };
}

/** Newest first: by the stamp in the name, else by when the file last changed. */
export function sortRecordings<T extends { name: string; modified: number | null }>(entries: T[]): T[] {
  const time = (e: T) => recordingName(e.name).at?.getTime() ?? (e.modified ?? 0) * 1000;
  return [...entries].sort((a, b) => time(b) - time(a));
}
