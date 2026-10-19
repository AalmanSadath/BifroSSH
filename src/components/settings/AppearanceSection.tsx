import { useAppStore, resolveAccent, resolveAppTheme } from '../../store/appStore';
import { ColorPickerField } from '../ColorPicker';
import { usePatch } from './Picker';
import type { AppTheme } from '../../types';
import { isAndroid } from '../../platform';

/** System first: it is the one that defers rather than decides. */
const APP_THEMES: { value: AppTheme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'amoled', label: 'AMOLED' },
];

/**
 * Each palette's own accent, as tokens.css declares it. The picker shows this
 * when nothing overrides it; it showed the dark one whatever the theme.
 */
const THEME_ACCENTS: Record<'dark' | 'light' | 'amoled', string> = {
  dark: '#58a6ff',
  light: '#155397',
  amoled: '#a78bfa',
};

/** How the app itself looks; the terminal's own colours are next door. */
export default function AppearanceSection() {
  const { settings, systemAppearance } = useAppStore();
  const patch = usePatch();
  // What the picker should show: the user's colour, else the desktop's,
  // else the one the theme in use has of its own.
  const accent = resolveAccent(settings, systemAppearance)
    ?? THEME_ACCENTS[resolveAppTheme(settings.app_theme, systemAppearance)];

  return (
    <section className="panel-section">
      <h3>Appearance</h3>
      <div className="form-group">
        <label>App Theme</label>
        <div className="toggle-row" style={{ maxWidth: 320 }}>
          {APP_THEMES.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={`toggle-btn${settings.app_theme === value ? ' active' : ''}`}
              onClick={() => patch({ app_theme: value })}
            >
              {label}
            </button>
          ))}
        </div>
        {settings.app_theme === 'system' && (
          <p className="form-hint">
            {systemAppearance.color_scheme === 'dark'
              ? 'Following the system theme, which is set to dark.'
              : 'Following the system theme, which is set to light.'}
          </p>
        )}
      </div>

      <div className="form-group">
        <label>Accent Colour</label>
        <div className="accent-row">
          <ColorPickerField
            value={accent}
            onChange={(v) => patch({ accent_color: v })}
          />
          {settings.accent_color !== null && (
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={() => patch({ accent_color: null })}
            >
              Use system accent
            </button>
          )}
        </div>
        <p className="form-hint">
          {settings.accent_color !== null
            ? 'Your own colour. Reset it to follow the system again.'
            : systemAppearance.accent
              ? 'Following the system accent, and changes with it.'
              : 'The system exposes no accent, so the theme’s own is used.'}
        </p>
      </div>

      {/* Nothing hovers on a touch screen. */}
      {!isAndroid && <>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={settings.show_hover_hints}
          onChange={(e) => patch({ show_hover_hints: e.target.checked })}
        />
        <span>Show hover hints</span>
      </label>
      <p className="form-hint">Toggles the tooltips that explain what a control does.</p>
      </>}
    </section>
  );
}
