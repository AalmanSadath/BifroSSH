import { describe, expect, it } from 'vitest';
import { DEFAULT_HIGHLIGHT_RULES, compileRules, matchesIn, patternError } from './highlight';
import type { HighlightRule } from './types';

const rule = (pattern: string, color: string, case_sensitive = false): HighlightRule => ({
  pattern,
  color,
  case_sensitive,
});

const words = (text: string, rules: HighlightRule[]) =>
  matchesIn(text, compileRules(rules)).map((m) => [text.slice(m.start, m.start + m.length), m.color]);

describe('matchesIn', () => {
  it('colours whole words with the defaults and leaves parts of words alone', () => {
    expect(words('build failed: error 2; warning: x; tests ok', DEFAULT_HIGHLIGHT_RULES)).toEqual([
      ['failed', 'red'],
      ['error', 'red'],
      ['warning', 'yellow'],
      ['ok', 'green'],
    ]);
    expect(words('errorless token booking', DEFAULT_HIGHLIGHT_RULES)).toEqual([]);
  });

  it('ignores case unless the rule asks for it', () => {
    expect(words('ERROR Error error', [rule('error', 'red')])).toHaveLength(3);
    expect(words('ERROR Error error', [rule('error', 'red', true)])).toEqual([['error', 'red']]);
  });

  it('gives an overlap to the match that starts first, then to the earlier rule', () => {
    expect(words('connection refused', [rule('refused', 'red'), rule('connection refused', 'yellow')]))
      .toEqual([['connection refused', 'yellow']]);
    expect(words('fatal', [rule('fatal', 'red'), rule('fat', 'green')])).toEqual([['fatal', 'red']]);
  });

  it('drops a pattern that does not compile and keeps the rest', () => {
    expect(words('error here', [rule('(unclosed', 'red'), rule('here', 'green')])).toEqual([
      ['here', 'green'],
    ]);
  });

  it('skips a match with nothing in it', () => {
    expect(words('abc', [rule('x*', 'red')])).toEqual([]);
  });

  it('stops at fifty on one line', () => {
    expect(words('a '.repeat(200), [rule('a', 'red')])).toHaveLength(50);
  });

  it('can be run twice with the same compiled rules', () => {
    const compiled = compileRules([rule('ok', 'green')]);
    expect(matchesIn('ok', compiled)).toHaveLength(1);
    expect(matchesIn('ok', compiled)).toHaveLength(1);
  });
});

describe('patternError', () => {
  it('says what is wrong with a pattern, and nothing about a good one', () => {
    expect(patternError('\\berror\\b')).toBeNull();
    expect(patternError('')).toBe('Empty');
    expect(patternError('(')).not.toBeNull();
    expect(patternError('a'.repeat(201))).toContain('200');
  });
});
