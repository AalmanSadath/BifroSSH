/**
 * Keyword highlighting: which stretches of a line of terminal output a set of
 * rules colours.
 *
 * Pure, so it is tested without a terminal. Drawing the result is
 * `terminalHighlighter.ts`, which calls this once per changed row.
 */

import type { HighlightRule } from './types';

/**
 * The rules a fresh install has, and what "Restore defaults" puts back. The
 * same three as `HighlightRule::defaults` in `models.rs`, which is what a
 * settings file without any reads as.
 */
export const DEFAULT_HIGHLIGHT_RULES: HighlightRule[] = [
  { pattern: '\\b(error|errors|failed|failure|fatal)\\b', color: 'red', case_sensitive: false },
  { pattern: '\\b(warn|warning|warnings)\\b', color: 'yellow', case_sensitive: false },
  { pattern: '\\b(ok|success|succeeded|done)\\b', color: 'green', case_sensitive: false },
];

/** The colours a rule can pick, named as the xterm theme names them. */
export const HIGHLIGHT_COLORS = [
  'red', 'green', 'yellow', 'blue', 'magenta', 'cyan',
  'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan',
] as const;

/** A pattern longer than this is a mistake or a paste, not a keyword. */
const MAX_PATTERN = 200;

/** More than this on one row is a wall of colour, not a highlight. */
const MAX_PER_LINE = 50;

export interface CompiledRule {
  re: RegExp;
  color: string;
}

export interface Match {
  start: number;
  length: number;
  color: string;
}

/** Whether a pattern compiles, for the settings editor to mark a bad row. */
export function patternError(pattern: string): string | null {
  if (pattern.trim() === '') return 'Empty';
  if (pattern.length > MAX_PATTERN) return `Longer than ${MAX_PATTERN} characters`;
  try {
    new RegExp(pattern);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * The rules that can run. One that does not compile is left out rather than
 * refused: a typo in one rule should not switch off the rest.
 */
export function compileRules(rules: HighlightRule[]): CompiledRule[] {
  return rules.flatMap((rule) => {
    if (patternError(rule.pattern) !== null) return [];
    return [{ re: new RegExp(rule.pattern, rule.case_sensitive ? 'g' : 'gi'), color: rule.color }];
  });
}

/**
 * The coloured stretches of one line, left to right, never overlapping.
 *
 * Where two rules match overlapping text, the one that starts first wins, and
 * at the same start the earlier rule does: the order in Settings is the order
 * of precedence. A pattern that can match nothing (`a*`) is skipped where it
 * does, since a zero-width stretch has nothing to colour.
 */
export function matchesIn(text: string, rules: CompiledRule[]): Match[] {
  const found: (Match & { rank: number })[] = [];
  rules.forEach((rule, rank) => {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      if (m[0].length === 0 || m.index === undefined) continue;
      found.push({ start: m.index, length: m[0].length, color: rule.color, rank });
      if (found.length > MAX_PER_LINE * rules.length) break;
    }
  });
  found.sort((a, b) => a.start - b.start || a.rank - b.rank);

  const kept: Match[] = [];
  let end = 0;
  for (const m of found) {
    if (m.start < end) continue;
    kept.push({ start: m.start, length: m.length, color: m.color });
    end = m.start + m.length;
    if (kept.length === MAX_PER_LINE) break;
  }
  return kept;
}
