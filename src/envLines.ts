/**
 * Reading the environment block on a host, the same way the backend does.
 *
 * The parse that counts is `env_pairs` in `models.rs`, which decides what is
 * sent. This one exists so the form can say what that parse will make of the
 * text while it is being typed: a line quietly dropped at connect time, on a
 * server that would have discarded it without a word anyway, is a typo nobody
 * ever finds. The two must agree, so the cases here are the cases there.
 */

export interface EnvLine {
  /** 1-based, so it can be named in a message the way an editor numbers it. */
  line: number;
  name: string;
  value: string;
}

/** A name a shell would accept: letters, digits and underscore, not leading with a digit. */
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The variables in the block, in the order they were written, and the numbers
 * of the lines that are neither a variable nor blank nor a comment.
 */
export function readEnv(text: string): { vars: EnvLine[]; bad: number[] } {
  const vars: EnvLine[] = [];
  const bad: number[] = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/\r$/, '').trimStart();
    if (line === '' || line.startsWith('#')) return;
    const at = line.indexOf('=');
    const name = at === -1 ? '' : line.slice(0, at).trimEnd();
    if (at === -1 || !NAME.test(name)) {
      bad.push(i + 1);
      return;
    }
    vars.push({ line: i + 1, name, value: line.slice(at + 1) });
  });
  return { vars, bad };
}

/** What the form says under the field, or nothing while it is empty. */
export function envSummary(text: string): string | null {
  if (text.trim() === '') return null;
  const { vars, bad } = readEnv(text);
  const counted = `${vars.length} ${vars.length === 1 ? 'variable' : 'variables'}`;
  if (bad.length === 0) return counted;
  const lines = bad.join(', ');
  return `${counted}. ${bad.length === 1 ? `Line ${lines} is not one` : `Lines ${lines} are not variables`} and will not be sent.`;
}
