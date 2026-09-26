import { describe, expect, it } from 'vitest';
import { suggestionFor } from './suggest';

const history = ['git status', 'git push origin main', 'ls -la /tmp', 'LS'];

describe('suggestionFor', () => {
  it('offers the rest of the most recent command that starts the same way', () => {
    expect(suggestionFor('git', history)).toBe(' status');
    expect(suggestionFor('git p', history)).toBe('ush origin main');
  });

  it('offers nothing for an empty line or one typed with a leading space', () => {
    expect(suggestionFor('', history)).toBeNull();
    expect(suggestionFor(' git', history)).toBeNull();
  });

  it('offers nothing when no command starts that way, or it is already whole', () => {
    expect(suggestionFor('docker', history)).toBeNull();
    expect(suggestionFor('git status', history)).toBeNull();
  });

  it('keeps case, as the shell does', () => {
    expect(suggestionFor('ls', history)).toBe(' -la /tmp');
    expect(suggestionFor('Ls', history)).toBeNull();
  });
});
