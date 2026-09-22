/**
 * Placeholders in a codeprint: `{{name}}` asks for a value when the
 * codeprint is used, `{{name:default}}` offers one. Pure, so the parsing
 * has tests; the form that asks is SnippetPromptModal.
 */

export interface Placeholder {
  name: string;
  /** What `{{name:default}}` offered; null for a bare `{{name}}`. */
  fallback: string | null;
}

/**
 * `{{name}}` or `{{name:anything up to the closing braces}}`. The name is
 * an identifier so that `{{ }}`, `{{1x}}` and a stray `{{` in a shell
 * expression stay text.
 */
const PLACEHOLDER = /\{\{([A-Za-z_][A-Za-z0-9_]*)(?::([^{}]*))?\}\}/g;

/** Each name once, in the order it first appears. */
export function placeholders(command: string): Placeholder[] {
  const seen = new Map<string, Placeholder>();
  for (const m of command.matchAll(PLACEHOLDER)) {
    const name = m[1];
    const fallback = m[2] ?? null;
    const known = seen.get(name);
    if (!known) seen.set(name, { name, fallback });
    // A later occurrence may carry the default the first one lacked.
    else if (known.fallback === null && fallback !== null) known.fallback = fallback;
  }
  return Array.from(seen.values());
}

/**
 * The command with every placeholder replaced. A name with no value takes
 * its default, and with no default becomes nothing at all.
 */
export function fill(command: string, values: Record<string, string>): string {
  const defaults = new Map(placeholders(command).map((p) => [p.name, p.fallback ?? '']));
  return command.replace(PLACEHOLDER, (_, name: string) => values[name] ?? defaults.get(name) ?? '');
}
