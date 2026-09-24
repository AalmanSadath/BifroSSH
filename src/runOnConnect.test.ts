import { describe, expect, it } from 'vitest';
import { hasClear, withClear } from './runOnConnect';
import { snippetFor } from './shellIntegration';

describe('hasClear', () => {
  it('sees a clear on the end and nothing else', () => {
    expect(hasClear('clear')).toBe(true);
    expect(hasClear('tmux attach; clear')).toBe(true);
    expect(hasClear('  tmux attach ;  clear  ')).toBe(true);
    expect(hasClear('tmux attach')).toBe(false);
    expect(hasClear('clear; tmux attach')).toBe(false);
    expect(hasClear('')).toBe(false);
  });

  it('is not fooled by the shell integration snippet', () => {
    // It has semicolons of its own, inside quotes and function bodies.
    expect(hasClear(snippetFor('bash'))).toBe(false);
    expect(hasClear(snippetFor('zsh'))).toBe(false);
    expect(hasClear(`${snippetFor('bash')}; clear`)).toBe(true);
  });
});

describe('withClear', () => {
  it('adds it to the end, whatever was there', () => {
    expect(withClear('', true)).toBe('clear');
    expect(withClear('tmux attach', true)).toBe('tmux attach; clear');
  });

  it('takes it off again, leaving the rest as it was', () => {
    expect(withClear('tmux attach; clear', false)).toBe('tmux attach');
    expect(withClear('clear', false)).toBe('');
  });

  it('changes nothing when the answer is already right', () => {
    expect(withClear('tmux attach; clear', true)).toBe('tmux attach; clear');
    expect(withClear('tmux attach', false)).toBe('tmux attach');
  });

  it('survives being turned on and off around the snippet', () => {
    const snippet = snippetFor('zsh');
    expect(withClear(withClear(snippet, true), false)).toBe(snippet);
  });
});
