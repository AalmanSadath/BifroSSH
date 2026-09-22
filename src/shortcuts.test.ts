import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  TERMINAL_ACTIONS,
  actionFor,
  chordOf,
  conflictsIn,
  formatChord,
  formatChords,
  ownerOf,
  resolve,
  tabIndexFor,
  withBinding,
} from './shortcuts';

function press(code: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) {
  return {
    code,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
  };
}

describe('chordOf', () => {
  it('names modifiers in a fixed order, whatever order they were pressed', () => {
    expect(chordOf(press('KeyL', { shiftKey: true, ctrlKey: true }))).toBe('Ctrl+Shift+KeyL');
    expect(chordOf(press('KeyL', { ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+KeyL');
    expect(chordOf(press('PageDown', { ctrlKey: true }))).toBe('Ctrl+PageDown');
    expect(chordOf(press('KeyK', { altKey: true, metaKey: true }))).toBe('Alt+Meta+KeyK');
  });

  it('refuses a bare key, which the terminal is owed', () => {
    expect(chordOf(press('KeyL'))).toBeNull();
    expect(chordOf(press('Escape'))).toBeNull();
  });

  it('refuses a modifier pressed on its own', () => {
    expect(chordOf(press('ControlLeft', { ctrlKey: true }))).toBeNull();
    expect(chordOf(press('ShiftRight', { shiftKey: true }))).toBeNull();
  });
});

describe('formatChord', () => {
  it('reads a chord the way a key cap does', () => {
    expect(formatChord('Ctrl+Shift+KeyL')).toBe('Ctrl+Shift+L');
    expect(formatChord('Ctrl+PageDown')).toBe('Ctrl+Page Down');
    expect(formatChord('Ctrl+Digit1')).toBe('Ctrl+1');
    expect(formatChord('Ctrl+Tab')).toBe('Ctrl+Tab');
    expect(formatChord('')).toBe('Unbound');
  });

  it('joins alternatives, and says so when there are none', () => {
    expect(formatChords(['Ctrl+Tab', 'Ctrl+PageDown'])).toBe('Ctrl+Tab or Ctrl+Page Down');
    expect(formatChords([])).toBe('Unbound');
  });
});

describe('resolve', () => {
  it('takes the defaults where nothing was changed, splitting alternatives', () => {
    const map = resolve({});
    expect(map['next-tab']).toEqual(['Ctrl+Tab', 'Ctrl+PageDown']);
    expect(map['palette']).toEqual(['Ctrl+KeyK']);
  });

  it('lets one override replace every alternative of its action', () => {
    expect(resolve({ 'next-tab': 'Alt+KeyN' })['next-tab']).toEqual(['Alt+KeyN']);
  });

  it('reads an empty override as unbound', () => {
    expect(resolve({ 'term-paste': '' })['term-paste']).toEqual([]);
  });

  it('covers every action, so a lookup never finds a hole', () => {
    const map = resolve({});
    for (const action of ACTIONS) expect(Array.isArray(map[action.id])).toBe(true);
  });
});

describe('actionFor', () => {
  it('finds the action a chord is bound to', () => {
    const map = resolve({});
    expect(actionFor(press('KeyK', { ctrlKey: true }), map)).toBe('palette');
    expect(actionFor(press('Tab', { ctrlKey: true, shiftKey: true }), map)).toBe('prev-tab');
    expect(actionFor(press('PageUp', { ctrlKey: true }), map)).toBe('prev-tab');
  });

  it('finds nothing for a chord nobody claims', () => {
    expect(actionFor(press('KeyK', { ctrlKey: true, altKey: true }), resolve({}))).toBeNull();
  });

  it('finds nothing for an unbound action', () => {
    const map = resolve({ 'term-paste': '' });
    expect(actionFor(press('KeyV', { ctrlKey: true, shiftKey: true }), map)).toBeNull();
  });

  it('searches only the surface it was asked about', () => {
    const map = resolve({});
    expect(actionFor(press('KeyF', { ctrlKey: true, shiftKey: true }), map, TERMINAL_ACTIONS)).toBe('term-search');
    expect(actionFor(press('KeyK', { ctrlKey: true }), map, TERMINAL_ACTIONS)).toBeNull();
  });

  it('follows a rebinding and lets the old chord go', () => {
    const map = resolve({ 'close-tab': 'Ctrl+Shift+KeyQ' });
    expect(actionFor(press('KeyQ', { ctrlKey: true, shiftKey: true }), map)).toBe('close-tab');
    expect(actionFor(press('KeyW', { ctrlKey: true, shiftKey: true }), map)).toBeNull();
  });
});

describe('tabIndexFor', () => {
  it('counts from one, and reads nine as the last tab', () => {
    expect(tabIndexFor('select-tab-1', 3)).toBe(0);
    expect(tabIndexFor('select-tab-3', 3)).toBe(2);
    expect(tabIndexFor('select-tab-9', 3)).toBe(2);
    expect(tabIndexFor('select-tab-9', 12)).toBe(11);
  });

  it('finds nothing past the end of the strip, or in an empty one', () => {
    expect(tabIndexFor('select-tab-4', 3)).toBeNull();
    expect(tabIndexFor('select-tab-1', 0)).toBeNull();
    expect(tabIndexFor('select-tab-9', 0)).toBeNull();
  });

  it('finds nothing for an action that is not a numbered tab', () => {
    expect(tabIndexFor('close-tab', 3)).toBeNull();
  });
});

describe('ownerOf', () => {
  it('names the action a chord is already bound to', () => {
    const map = resolve({});
    expect(ownerOf(map, 'Ctrl+Shift+KeyW', 'palette')).toBe('close-tab');
    expect(ownerOf(map, 'Ctrl+PageUp', 'next-tab')).toBe('prev-tab');
  });

  it('ignores the action being rebound, so keeping its own chord is not a clash', () => {
    expect(ownerOf(resolve({}), 'Ctrl+Shift+KeyW', 'close-tab')).toBeNull();
  });

  it('finds nobody for a free chord', () => {
    expect(ownerOf(resolve({}), 'Ctrl+Shift+KeyQ', 'close-tab')).toBeNull();
  });
});

describe('conflictsIn', () => {
  it('says nothing about the defaults', () => {
    expect(conflictsIn(resolve({})).size).toBe(0);
  });

  it('names every action claiming the same chord', () => {
    const conflicts = conflictsIn(resolve({ 'term-copy': 'Ctrl+KeyK' }));
    expect(conflicts.get('Ctrl+KeyK')).toEqual(['palette', 'term-copy']);
  });
});

describe('withBinding', () => {
  it('records a rebinding and an unbinding, and forgets a reset', () => {
    let overrides = withBinding({}, 'palette', 'Ctrl+Shift+KeyP');
    expect(overrides).toEqual({ palette: 'Ctrl+Shift+KeyP' });
    overrides = withBinding(overrides, 'term-paste', '');
    expect(overrides['term-paste']).toBe('');
    overrides = withBinding(overrides, 'palette', null);
    expect('palette' in overrides).toBe(false);
  });
});
