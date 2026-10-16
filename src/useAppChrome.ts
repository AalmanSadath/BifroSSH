import { useEffect, useMemo } from 'react';
import { listen } from '@tauri-apps/api/event';
import * as ipc from './ipc';
import { useAppStore, resolveAccent, resolveAppTheme } from './store/appStore';
import { accentTokens } from './styles/accent';
import type { SystemAppearance } from './types';

/**
 * The app's palette and accent, followed live and applied to the page.
 *
 * Every window draws itself this way, the main one and a tab's own, so both
 * follow the setting and the desktop the same. Returns what goes on the
 * window's `.app` element; the body gets the same itself, for portals.
 */
export function useAppChrome(): { className: string; style: React.CSSProperties | undefined } {
  const settings = useAppStore((s) => s.settings);
  const systemAppearance = useAppStore((s) => s.systemAppearance);
  const setSystemAppearance = useAppStore((s) => s.setSystemAppearance);

  const resolvedTheme = resolveAppTheme(settings.app_theme, systemAppearance);
  const accent = resolveAccent(settings, systemAppearance);

  // Asked once at startup, then followed: the system reports a desktop that
  // changes its mind, so a theme set to system switches without a restart.
  useEffect(() => {
    ipc.systemAppearance().then(setSystemAppearance).catch(() => {});
    const unlisten = listen<SystemAppearance>(
      'system-appearance-changed',
      (e) => setSystemAppearance(e.payload),
    );
    return () => { unlisten.then((fn) => fn()); };
  }, [setSystemAppearance]);

  useEffect(() => {
    const body = document.body;
    body.classList.remove('app-light', 'app-amoled');
    if (resolvedTheme === 'light') body.classList.add('app-light');
    else if (resolvedTheme === 'amoled') body.classList.add('app-amoled');
  }, [resolvedTheme]);

  /**
   * The accent overrides the palette's own, as three properties rather than
   * one. A colour needs a foreground that stays legible on it and a hover a
   * shade along, and both were hand-picked per theme against a known accent.
   *
   * Written onto the same elements that carry the theme class, not onto
   * <html>. Custom properties inherit, so the nearest declaration wins, and
   * the light and amoled palettes redeclare --accent on body and on .app
   * below it: an override on the root was shadowed by both, which is why only
   * the dark theme, the one declared on bare :root, appeared to follow.
   *
   * Portals render into body rather than into .app, so both need it.
   */
  // Memoised on the colour itself: a fresh object each render would restyle
  // the body on every one.
  const accentVars = useMemo(() => {
    const tokens = accent ? accentTokens(accent) : null;
    return tokens
      ? ({
          '--accent': tokens.accent,
          '--accent-hover': tokens.accentHover,
          '--on-accent': tokens.onAccent,
        } as React.CSSProperties)
      : undefined;
  }, [accent]);

  useEffect(() => {
    const { style } = document.body;
    // Removed rather than set to a default when there is nothing to apply, so
    // whichever palette is in force goes back to the values it ships with.
    for (const [name, value] of Object.entries(accentVars ?? {})) {
      style.setProperty(name, value as string);
    }
    if (!accentVars) {
      for (const name of ['--accent', '--accent-hover', '--on-accent']) {
        style.removeProperty(name);
      }
    }
  }, [accentVars]);

  return {
    className: `app${resolvedTheme === 'light' ? ' app-light' : resolvedTheme === 'amoled' ? ' app-amoled' : ''}`,
    style: accentVars,
  };
}
