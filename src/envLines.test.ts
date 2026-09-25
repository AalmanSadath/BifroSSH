import { describe, expect, it } from 'vitest';
import { envSummary, readEnv } from './envLines';

describe('readEnv', () => {
  it('reads variables in the order they were written', () => {
    expect(readEnv('LANG=en_GB.UTF-8\nEDITOR=vim').vars).toEqual([
      { line: 1, name: 'LANG', value: 'en_GB.UTF-8' },
      { line: 2, name: 'EDITOR', value: 'vim' },
    ]);
  });

  it('splits on the first equals only', () => {
    expect(readEnv('OPTS=--flag=1 --other=2').vars[0].value).toBe('--flag=1 --other=2');
  });

  it('passes over blank lines, comments and carriage returns', () => {
    const { vars, bad } = readEnv('\n  # a note\r\nLANG=C\r\n\n');
    expect(vars).toEqual([{ line: 3, name: 'LANG', value: 'C' }]);
    expect(bad).toEqual([]);
  });

  it('names the lines the backend would drop', () => {
    const { vars, bad } = readEnv('LANG=C\njust a sentence\n2FAST=no\nhas space=no\n=novalue');
    expect(vars.map((v) => v.name)).toEqual(['LANG']);
    expect(bad).toEqual([2, 3, 4, 5]);
  });

  it('trims the name and keeps the value as typed', () => {
    expect(readEnv('  PAGER = less ').vars[0]).toEqual({ line: 1, name: 'PAGER', value: ' less ' });
  });
});

describe('envSummary', () => {
  it('says nothing about an empty field', () => {
    expect(envSummary('')).toBeNull();
    expect(envSummary('  \n ')).toBeNull();
  });

  it('counts what will be sent', () => {
    expect(envSummary('LANG=C')).toBe('1 variable');
    expect(envSummary('LANG=C\nEDITOR=vi')).toBe('2 variables');
  });

  it('points at the line that is not one', () => {
    expect(envSummary('LANG=C\noops')).toBe('1 variable. Line 2 is not one and will not be sent.');
    expect(envSummary('oops\nalso oops')).toBe(
      '0 variables. Lines 1, 2 are not variables and will not be sent.',
    );
  });
});
