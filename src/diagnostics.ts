/**
 * What went wrong in this session, kept so it can be handed over.
 *
 * Every error the app shows was a single slot: a banner that the next one
 * replaced, a crash screen that a reload cleared. A bug report then held
 * whatever the user remembered of the first one. This keeps the last few, in
 * memory only: they are for the session in front of the user, and writing
 * error text to disk would be a second thing to get wrong.
 */

export interface DiagError {
  /** Epoch ms. */
  at: number;
  /** Where it surfaced: a banner, a tab, the crash screen, an uncaught throw. */
  where: string;
  message: string;
}

/** How many are kept. Enough for the lead-up to a failure, not a log. */
export const KEPT_ERRORS = 20;

/**
 * The list with one more on the end, the oldest dropped past the cap.
 *
 * The same message arriving twice in a row from the same place is one entry:
 * a retry loop that fails the same way every few seconds would otherwise
 * push everything that came before it out of the list.
 */
export function withError(list: DiagError[], entry: DiagError, cap = KEPT_ERRORS): DiagError[] {
  const last = list[list.length - 1];
  if (last && last.where === entry.where && last.message === entry.message) {
    return [...list.slice(0, -1), entry];
  }
  const next = [...list, entry];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

/**
 * Facts about this install worth having in a bug report, gathered by the
 * caller since half of them come from the backend.
 *
 * Nothing here names a host, a user or a key, and the data folder has the home
 * directory replaced with `~`, so the only thing that can identify anyone is
 * the error text itself. That is the point of the report, so the button says
 * to read it before pasting it anywhere.
 */
export interface DiagFacts {
  version: string;
  platform: string;
  /** `navigator.userAgent`, which carries the WebKit build the window runs on. */
  userAgent: string;
  window: { width: number; height: number; scale: number };
  dataDir: string;
  /** The home directory, so it can be taken out of `dataDir`. */
  home: string;
  counts: { hosts: number; keys: number; identities: number; tunnels: number; tabs: number };
  /** Settings that are a choice between values, never free text. */
  settings: Record<string, string | number | boolean>;
}

/** The report, as plain text for an issue. */
export function formatDiagnostics(facts: DiagFacts, errors: DiagError[]): string {
  const { counts, window: win } = facts;
  const lines = [
    `BifroSSH ${facts.version} on ${facts.platform}`,
    `WebView: ${facts.userAgent}`,
    `Window: ${win.width}x${win.height} at ${win.scale}x`,
    `Data: ${withoutHome(facts.dataDir, facts.home)}`,
    `Hosts ${counts.hosts} · keys ${counts.keys} · identities ${counts.identities} · tunnels ${counts.tunnels} · open tabs ${counts.tabs}`,
    `Settings: ${Object.entries(facts.settings).map(([k, v]) => `${k}=${v}`).join(' ')}`,
    '',
    errors.length === 0 ? 'No errors this session.' : `Errors this session, oldest first (${errors.length}):`,
    ...errors.map((e) => `${new Date(e.at).toISOString()} [${e.where}] ${e.message}`),
  ];
  return lines.join('\n');
}

/** A path with the home directory written as `~`, which says the same thing without the name. */
export function withoutHome(path: string, home: string): string {
  const trimmed = home.replace(/[\\/]+$/, '');
  if (trimmed === '' || !path.startsWith(trimmed)) return path;
  const rest = path.slice(trimmed.length);
  return rest === '' || rest[0] === '/' || rest[0] === '\\' ? `~${rest}` : path;
}
