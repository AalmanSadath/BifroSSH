import { describe, expect, it } from 'vitest';
import { resolveAccent, resolveAppTheme } from './appStore';
import type { SystemAppearance } from '../types';

const system = (over: Partial<SystemAppearance> = {}): SystemAppearance => ({
  color_scheme: 'no-preference',
  accent: null,
  ...over,
});

describe('resolveAppTheme', () => {
  it('leaves an explicit choice alone whatever the desktop says', () => {
    for (const chosen of ['dark', 'light', 'amoled'] as const) {
      expect(resolveAppTheme(chosen, system({ color_scheme: 'dark' }))).toBe(chosen);
      expect(resolveAppTheme(chosen, system({ color_scheme: 'light' }))).toBe(chosen);
    }
  });

  /**
   * The one that was wrong. GNOME's Appearance panel offers Default and Dark;
   * picking the light one sets color-scheme to `default`, which the portal
   * reports as no preference, and it never reports light at all. Resolving no
   * preference to dark meant switching the desktop to light did nothing.
   */
  it('treats a desktop with no preference as light, the way CSS does', () => {
    expect(resolveAppTheme('system', system({ color_scheme: 'no-preference' }))).toBe('light');
    expect(resolveAppTheme('system', system({ color_scheme: 'light' }))).toBe('light');
  });

  it('goes dark only when the desktop asks for dark', () => {
    expect(resolveAppTheme('system', system({ color_scheme: 'dark' }))).toBe('dark');
  });

  /** No desktop can ask for AMOLED, so system never resolves to it. */
  it('never resolves system to amoled', () => {
    for (const scheme of ['dark', 'light', 'no-preference'] as const) {
      expect(resolveAppTheme('system', system({ color_scheme: scheme }))).not.toBe('amoled');
    }
  });
});

describe('resolveAccent', () => {
  it('prefers the colour the user picked', () => {
    expect(resolveAccent({ accent_color: '#ff0000' }, system({ accent: '#9141ac' })))
      .toBe('#ff0000');
  });

  it('follows the desktop when the user has picked nothing', () => {
    expect(resolveAccent({ accent_color: null }, system({ accent: '#9141ac' })))
      .toBe('#9141ac');
  });

  /** Null leaves the palette's own accent in place rather than inventing one. */
  it('is null when neither has an opinion', () => {
    expect(resolveAccent({ accent_color: null }, system())).toBeNull();
  });
});
