/**
 * Matching and ordering for the command palette. Pure, so the ranking has
 * tests; the palette builds the commands and runs them.
 */

/** The sections, in the order they are shown. */
export const GROUPS = ['Tabs', 'Hosts', 'SFTP', 'Codeprints', 'Panels', 'Actions'] as const;
export type Group = typeof GROUPS[number];

export interface Command {
  id: string;
  title: string;
  /** The line under the title; matched too, so a host is found by its address. */
  subtitle?: string;
  group: Group;
  run: () => void;
}

/**
 * How well `text` answers `query`, or null for no match.
 *
 * The letters have to appear in order but not together, so "prdb" finds
 * "prod-db". A hit at the start of the text or of a word is worth more
 * than one in the middle, and letters found next to each other are worth
 * more than letters found apart, which is what makes the exact prefix win.
 */
export function score(text: string, query: string): number | null {
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  if (q === '') return 0;
  let at = 0;
  let total = 0;
  let last = -2;
  for (const ch of q) {
    const found = t.indexOf(ch, at);
    if (found < 0) return null;
    let points = 1;
    if (found === 0) points += 8;
    else if (!/[a-z0-9]/.test(t[found - 1])) points += 4;
    if (found === last + 1) points += 3;
    total += points;
    last = found;
    at = found + 1;
  }
  // A short name matching is a better answer than a long one: "db" should
  // find the host called db before the one called database-replica-2.
  return total - text.length * 0.01;
}

/**
 * The commands worth showing, best first. A command matches on its title
 * or its subtitle, and the title's score wins when both match. Ties keep
 * the order the caller built them in, which is group by group.
 */
export function rankCommands(commands: Command[], query: string): Command[] {
  const q = query.trim();
  if (q === '') return commands;
  const scored: { command: Command; score: number; at: number }[] = [];
  commands.forEach((command, at) => {
    const title = score(command.title, q);
    // A subtitle hit is a weaker answer than a title hit of the same shape.
    const subtitle = command.subtitle ? score(command.subtitle, q) : null;
    const best = title !== null && subtitle !== null ? Math.max(title, subtitle - 2)
      : title !== null ? title
        : subtitle !== null ? subtitle - 2 : null;
    if (best !== null) scored.push({ command, score: best, at });
  });
  scored.sort((a, b) => b.score - a.score || a.at - b.at);
  return scored.map((s) => s.command);
}

/** The commands grouped for display, in GROUPS order, empty groups dropped. */
export function bySection(commands: Command[]): { group: Group; commands: Command[] }[] {
  return GROUPS
    .map((group) => ({ group, commands: commands.filter((c) => c.group === group) }))
    .filter((s) => s.commands.length > 0);
}
