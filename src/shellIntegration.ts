/**
 * The shell side of the tab's activity chip.
 *
 * A stock server emits no OSC 133 marks, so the chip stays empty until the
 * shell is told to send them. These are the lines that do it, one per shell,
 * written to be safe to paste into a live session and safe to send as a host's
 * run-on-connect: each is a single line, each keeps whatever hooks were
 * already set, and each prints nothing a terminal without the marks would
 * show.
 *
 * Nothing is ever sent on its own. A snippet pushed at a shell it was not
 * written for, or at a restricted account, would print noise into the session
 * rather than quietly doing nothing, so this is offered and never assumed.
 */

export type ShellKind = 'bash' | 'zsh';

export const SHELLS: { id: ShellKind; label: string }[] = [
  { id: 'bash', label: 'bash' },
  { id: 'zsh', label: 'zsh' },
];

/**
 * PS0 is printed after Enter and before the command runs, which is exactly
 * where C belongs. PROMPT_COMMAND runs before each prompt, where the previous
 * command's status is still readable, so D and A go out together. Whatever
 * PROMPT_COMMAND already held is kept after it.
 */
const BASH = 'PS0=$\'\\e]133;C\\a\'; __bifr_prompt() { local ret=$?; printf \'\\e]133;D;%s\\a\\e]133;A\\a\' "$ret"; }; PROMPT_COMMAND="__bifr_prompt${PROMPT_COMMAND:+; $PROMPT_COMMAND}"';

/**
 * add-zsh-hook rather than defining precmd and preexec outright, which would
 * replace the ones a configured shell already has.
 */
const ZSH = 'autoload -Uz add-zsh-hook; __bifr_precmd() { local ret=$?; printf \'\\e]133;D;%s\\a\\e]133;A\\a\' "$ret"; }; __bifr_preexec() { printf \'\\e]133;C\\a\'; }; add-zsh-hook precmd __bifr_precmd; add-zsh-hook preexec __bifr_preexec';

export function snippetFor(shell: ShellKind): string {
  return shell === 'zsh' ? ZSH : BASH;
}

/**
 * The snippet added to what a host already runs on connect, or the snippet
 * alone where it runs nothing yet. Joined with `;` because the field is one
 * line sent as if typed.
 */
export function withIntegration(runOnConnect: string, shell: ShellKind): string {
  const existing = runOnConnect.trim();
  const snippet = snippetFor(shell);
  if (existing === '') return snippet;
  if (existing.includes('__bifr_prompt') || existing.includes('__bifr_precmd')) return existing;
  return `${existing}; ${snippet}`;
}
