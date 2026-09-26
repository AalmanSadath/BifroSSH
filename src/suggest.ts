/**
 * What to suggest for a partly typed command.
 *
 * The most recent command that starts with exactly what has been typed, less
 * what has been typed. Case matters, as it does to the shell: `ls` and `LS`
 * are different commands. Nothing is offered for an empty line, since the
 * newest command in history is not a guess about anything, or for a line
 * that starts with a space, which the user is keeping out of history.
 */
export function suggestionFor(typed: string, history: string[]): string | null {
  if (typed === '' || typed.startsWith(' ')) return null;
  const hit = history.find((c) => c.length > typed.length && c.startsWith(typed));
  return hit ? hit.slice(typed.length) : null;
}
