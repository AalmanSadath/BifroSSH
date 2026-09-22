import { useAppStore, resolveAccent } from '../../store/appStore';
import { ColorPickerField } from '../ColorPicker';
import { usePatch } from './Picker';
import type { AppTheme } from '../../types';

/** System first: it is the one that defers rather than decides. */
const APP_THEMES: { value: AppTheme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'amoled', label: 'AMOLED' },
];

/** How the app itself looks; the terminal's own colours are next door. */
export default function AppearanceSection() {
  const { settings, systemAppearance } = useAppStore();
  const patch = usePatch();
  // What the picker should show: the user's colour, else the desktop's,
  // else the dark palette's own, which is what an unthemed picker opens on.
  const accent = resolveAccent(settings, systemAppearance);

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
            value={accent ?? '#58a6ff'}
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

      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={settings.show_hover_hints}
          onChange={(e) => patch({ show_hover_hints: e.target.checked })}
        />
        <span>Show hover hints</span>
      </label>
      <p className="form-hint">Toggles the tooltips that explain what a control does.</p>
    </section>
  );
}
