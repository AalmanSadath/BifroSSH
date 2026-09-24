import { describe, expect, it } from 'vitest';
import { snippetFor, withIntegration } from './shellIntegration';

describe('snippetFor', () => {
  it('sends the three marks the chip is read from', () => {
    for (const shell of ['bash', 'zsh'] as const) {
      const snippet = snippetFor(shell);
      expect(snippet).toContain('133;C');
      expect(snippet).toContain('133;D;%s');
      expect(snippet).toContain('133;A');
    }
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

  it('does not add itself twice', () => {
    const once = withIntegration('tmux attach', 'zsh');
    expect(withIntegration(once, 'zsh')).toBe(once);
    expect(withIntegration(once, 'bash')).toBe(once);
  });
});
