import { useAppStore } from '../store/appStore';
import type { Settings } from '../types';

export default function SettingsPanel() {
  const { settings, saveSettings } = useAppStore();

  function patch(p: Partial<Settings>) {
    saveSettings({ ...settings, ...p });
  }

  return (
    <div className="panel">
      <div className="panel-title">Settings</div>

      <section className="panel-section">
        <h3>Appearance</h3>
        <div className="form-group">
          <label>App Theme</label>
          <div className="toggle-row" style={{ maxWidth: 240 }}>
            <button
              type="button"
              className={`toggle-btn${settings.app_theme === 'dark' ? ' active' : ''}`}
              onClick={() => patch({ app_theme: 'dark' })}
            >
              Dark
            </button>
            <button
              type="button"
              className={`toggle-btn${settings.app_theme === 'light' ? ' active' : ''}`}
              onClick={() => patch({ app_theme: 'light' })}
            >
              Light
            </button>
            <button
              type="button"
              className={`toggle-btn${settings.app_theme === 'amoled' ? ' active' : ''}`}
              onClick={() => patch({ app_theme: 'amoled' })}
            >
              AMOLED
            </button>
          </div>
        </div>
      </section>

      <section className="panel-section">
        <h3>Font</h3>
        <div className="form-row">
          <div className="form-group flex-1">
            <label>Family</label>
            <input
              value={settings.font_family}
              onChange={(e) => patch({ font_family: e.target.value })}
              placeholder="monospace"
            />
          </div>
          <div className="form-group port-group">
            <label>Size</label>
            <input
              type="number"
              min={8}
              max={32}
              value={settings.font_size}
              onChange={(e) => patch({ font_size: Number(e.target.value) })}
            />
          </div>
        </div>
      </section>

      <section className="panel-section">
        <h3>Cursor</h3>
        <div className="form-group">
          <label>Style</label>
          <select value={settings.cursor_style} onChange={(e) => patch({ cursor_style: e.target.value })}>
            <option value="block">Block</option>
            <option value="underline">Underline</option>
            <option value="bar">Bar</option>
          </select>
        </div>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.cursor_blink}
            onChange={(e) => patch({ cursor_blink: e.target.checked })}
          />
          <span>Cursor blink</span>
        </label>
      </section>

      <section className="panel-section">
        <h3>Connection</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <label style={{ margin: 0, whiteSpace: 'nowrap' }}>Global timeout (seconds)</label>
          <input
            type="number"
            min={1}
            max={3600}
            value={settings.connection_timeout_secs}
            onChange={(e) => patch({ connection_timeout_secs: Math.max(1, Number(e.target.value)) })}
            style={{ width: 80 }}
            className="no-spinner"
          />
        </div>
        <p className="form-hint">Per-host timeout can be set in host settings and overrides this value.</p>
      </section>

      <section className="panel-section">
        <h3>Interface</h3>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.show_hover_hints}
            onChange={(e) => patch({ show_hover_hints: e.target.checked })}
          />
          <span>Show hover hints on host cards</span>
        </label>
      </section>
    </div>
  );
}
