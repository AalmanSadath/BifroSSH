import { describe, expect, it } from 'vitest';
import { snippetFor, withIntegration } from './shellIntegration';

describe('snippetFor', () => {
  it('sends the three marks the chip is read from', () => {
    for (const shell of ['bash', 'zsh'] as const) {
      const snippet = snippetFor(shell);
      expect(snippet).toContain('133;C');
      expect(snippet).toContain('133;D;%s');
      expect(snippet).toContain('133;A');
      expect(snippet).toContain('133;B');
    }
  });

  it('marks the end of the prompt without adding to its width', () => {
    // Outside \\[ \\] or %{ %}, the shell would count the mark as printed
    // characters and wrap long lines in the wrong place.
    expect(snippetFor('bash')).toContain('\\[\\e]133;B\\a\\]');
    expect(snippetFor('zsh')).toContain('%{\\e]133;B\\a%}');
  });

  it('stays on one line, since it is sent as if typed', () => {
    expect(snippetFor('bash')).not.toContain('\n');
    expect(snippetFor('zsh')).not.toContain('\n');
  });

  it('keeps what the shell already had set', () => {
    // Replacing these outright would take a configured prompt with it.
    expect(snippetFor('bash')).toContain('${PROMPT_COMMAND:+');
    expect(snippetFor('zsh')).toContain('add-zsh-hook');
  });
});

describe('withIntegration', () => {
  it('is the whole field where the host runs nothing yet', () => {
    expect(withIntegration('', 'bash')).toBe(snippetFor('bash'));
    expect(withIntegration('   ', 'zsh')).toBe(snippetFor('zsh'));
  });

  it('follows what the host already runs', () => {
    expect(withIntegration('tmux attach', 'bash')).toBe(`tmux attach; ${snippetFor('bash')}`);
  });

  it('swaps an earlier version of the snippet for this one, keeping what was around it', () => {
    const oldBash = 'PS0=$\'\\e]133;C\\a\'; __bifr_prompt() { local ret=$?; printf \'\\e]133;D;%s\\a\\e]133;A\\a\' "$ret"; }; PROMPT_COMMAND="__bifr_prompt${PROMPT_COMMAND:+; $PROMPT_COMMAND}"';
    expect(withIntegration(`tmux attach; ${oldBash}`, 'bash')).toBe(`tmux attach; ${snippetFor('bash')}`);
    const oldZsh = 'autoload -Uz add-zsh-hook; __bifr_precmd() { local ret=$?; printf \'\\e]133;D;%s\\a\\e]133;A\\a\' "$ret"; }; __bifr_preexec() { printf \'\\e]133;C\\a\'; }; add-zsh-hook precmd __bifr_precmd; add-zsh-hook preexec __bifr_preexec';
    expect(withIntegration(oldZsh, 'zsh')).toBe(snippetFor('zsh'));
  });

  it('does not add itself twice', () => {
    const once = withIntegration('tmux attach', 'zsh');
    expect(withIntegration(once, 'zsh')).toBe(once);
    expect(withIntegration(once, 'bash')).toBe(once);
  });
});
