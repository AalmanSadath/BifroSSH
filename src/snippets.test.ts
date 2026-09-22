import { describe, expect, it } from 'vitest';
import { fill, placeholders } from './snippets';

describe('placeholders', () => {
  it('lists each name once, in order, with its default', () => {
    expect(placeholders('ssh {{user:root}}@{{host}} && echo {{user}}')).toEqual([
      { name: 'user', fallback: 'root' },
      { name: 'host', fallback: null },
    ]);
  });

  it('takes a default from a later occurrence when the first had none', () => {
    expect(placeholders('{{x}} {{x:1}}')).toEqual([{ name: 'x', fallback: '1' }]);
  });

  it('leaves anything that is not an identifier alone', () => {
    expect(placeholders('echo {{ }} {{1x}} {{a-b}} {x} {{{ }}}')).toEqual([]);
    expect(placeholders('plain command')).toEqual([]);
  });

  it('lets a default hold spaces and punctuation but not braces', () => {
    expect(placeholders('{{path:/var/log/app.log}} {{msg:hello, world}}')).toEqual([
      { name: 'path', fallback: '/var/log/app.log' },
      { name: 'msg', fallback: 'hello, world' },
    ]);
  });
});

describe('fill', () => {
  it('replaces every occurrence and falls back to the default or nothing', () => {
    expect(fill('{{a}} {{a}} {{b:2}} {{c}}', { a: 'x' })).toBe('x x 2 ');
    expect(fill('{{b:2}}', { b: '9' })).toBe('9');
  });

  it('leaves text without placeholders as it was', () => {
    expect(fill('ls -la {{ }}', {})).toBe('ls -la {{ }}');
  });
});
