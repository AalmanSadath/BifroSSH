import type { ResolvedTheme, Settings, SystemAppearance } from '../types';

/**
 * The chosen app theme, mirrored outside the encrypted store.
 *
 * Settings live in data.json, which cannot be read until the master key is
 * available, so with a passphrase set the unlock screen would render before
 * its own theme was knowable and always came up dark. The theme is not a
 * secret, and this is only a cache: data.json stays authoritative, and the
 * worst a stale or missing value can do is show one screen in the wrong
 * colours before the real settings load over it.
 */
const APP_THEME_CACHE = 'bifrossh_app_theme';

export function cachedAppTheme(): ResolvedTheme {
  const saved = localStorage.getItem(APP_THEME_CACHE);
  return saved === 'light' || saved === 'amoled' || saved === 'dark' ? saved : 'dark';
}

/**
 * Caches the palette actually painted, not the setting.
 *
 * The setting can now be "system", which tells the next first paint nothing:
 * it would have to ask the desktop before it knew what to draw, and the point
 * of this cache is to draw something right before anything has been asked.
 */
export function cacheAppTheme(theme: ResolvedTheme) {
  try {
    localStorage.setItem(APP_THEME_CACHE, theme);
  } catch {
    // Storage can be unavailable or full. Nothing here is worth failing over.
  }
}

/**
 * What the desktop last told us about itself.
 *
 * Read once at startup and again whenever the portal says it changed, so a
 * theme set to "system" follows the desktop live rather than only at launch.
 */
export const NO_APPEARANCE: SystemAppearance = { color_scheme: 'no-preference', accent: null };

/**
 * The palette to paint, given the setting and what the desktop reports.
 *
 * Only an explicit "dark" means dark. "No preference" resolves to light, which
 * looks like the wrong way round until you watch what desktops actually send:
 * GNOME's Appearance panel offers Default and Dark, and choosing the light one
 * sets color-scheme to `default`, which the portal reports as 0, no
 * preference. It never sends 2. Treating 0 as dark meant switching the desktop
 * to light did nothing at all.
 *
 * It is also what CSS does. `prefers-color-scheme` dropped its no-preference
 * value, and user agents report light when nothing has been asked for.
 */
export function resolveAppTheme(
  setting: Settings['app_theme'],
  system: SystemAppearance,
): ResolvedTheme {
  if (setting !== 'system') return setting;
  return system.color_scheme === 'dark' ? 'dark' : 'light';
}

/**
 * The accent to paint: the user's choice, else the desktop's, else none, which
 * leaves each palette's own built-in accent in place.
 */
export function resolveAccent(
  settings: Pick<Settings, 'accent_color'>,
  system: SystemAppearance,
): string | null {
  return settings.accent_color ?? system.accent;
}
