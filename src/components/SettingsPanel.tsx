import { useState } from 'react';
import { useAppStore } from '../store/appStore';
import ThemePicker from './ThemePicker';
import { THEMES } from '../styles/themes';
import type { Settings } from '../types';

export default function SettingsPanel() {
  const { settings, saveSettings } = useAppStore();
  const [themeExpanded, setThemeExpanded] = useState(false);

  function patch(p: Partial<Settings>) {
    saveSettings({ ...settings, ...p });
  }

  return (
    <div className="panel">
      <div className="panel-title">Settings</div>

      <section className="panel-section">
        <h3>Theme</h3>
        <button
          type="button"
          className="collapsible-header"
          onClick={() => setThemeExpanded((v) => !v)}
        >
          <span className="collapsible-title">Global Theme</span>
          <span className="collapsible-meta">{THEMES[settings.theme]?.name ?? settings.theme}</span>
          <span className={`collapsible-arrow${themeExpanded ? ' open' : ''}`}>▶</span>
        </button>
        {themeExpanded && (
          <div className="collapsible-body">
            <ThemePicker value={settings.theme} onChange={(theme) => patch({ theme })} />
          </div>
        )}
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
    </div>
  );
}
