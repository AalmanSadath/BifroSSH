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
 *
 * B, the end of the prompt, is where typing starts, which is what command
 * history needs. It goes at the end of PS1, inside \[ \] so bash does not
 * count it towards the prompt's width, and from a function that runs last: a
 * prompt framework that rebuilds PS1 before every prompt would otherwise drop
 * it. Appended only when it is not already there, so it is not added twice.
 */
const BASH = 'PS0=$\'\\e]133;C\\a\'; __bifr_prompt() { local ret=$?; printf \'\\e]133;D;%s\\a\\e]133;A\\a\' "$ret"; }; __bifr_input() { [[ $PS1 == *\'133;B\'* ]] || PS1="$PS1"\'\\[\\e]133;B\\a\\]\'; }; PROMPT_COMMAND="__bifr_prompt${PROMPT_COMMAND:+; $PROMPT_COMMAND}; __bifr_input"';

/**
 * add-zsh-hook rather than defining precmd and preexec outright, which would
 * replace the ones a configured shell already has. The B hook is added last
 * for the same reason as in bash, inside %{ %} for the same reason as \[ \].
 */
const ZSH = 'autoload -Uz add-zsh-hook; __bifr_precmd() { local ret=$?; printf \'\\e]133;D;%s\\a\\e]133;A\\a\' "$ret"; }; __bifr_preexec() { printf \'\\e]133;C\\a\'; }; __bifr_input() { [[ $PS1 == *\'133;B\'* ]] || PS1="$PS1"$\'%{\\e]133;B\\a%}\'; }; add-zsh-hook precmd __bifr_precmd; add-zsh-hook preexec __bifr_preexec; add-zsh-hook precmd __bifr_input';

/**
 * What the two snippets were before they sent B, so a host that still runs
 * one of them has it replaced rather than keeping it or gaining a second copy.
 */
const PREVIOUS = [
  'PS0=$\'\\e]133;C\\a\'; __bifr_prompt() { local ret=$?; printf \'\\e]133;D;%s\\a\\e]133;A\\a\' "$ret"; }; PROMPT_COMMAND="__bifr_prompt${PROMPT_COMMAND:+; $PROMPT_COMMAND}"',
  'autoload -Uz add-zsh-hook; __bifr_precmd() { local ret=$?; printf \'\\e]133;D;%s\\a\\e]133;A\\a\' "$ret"; }; __bifr_preexec() { printf \'\\e]133;C\\a\'; }; add-zsh-hook precmd __bifr_precmd; add-zsh-hook preexec __bifr_preexec',
];

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
  // An earlier version of either snippet is swapped for this one in place,
  // keeping whatever the field held around it.
  const old = PREVIOUS.find((p) => existing.includes(p));
  // A function rather than the string itself: the snippet holds `$'`, which
  // a replacement string reads as "the text after the match".
  if (old) return existing.replace(old, () => snippet);
  if (existing.includes('__bifr_prompt') || existing.includes('__bifr_precmd')) return existing;
  return `${existing}; ${snippet}`;
}
