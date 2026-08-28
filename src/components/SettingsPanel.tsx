import { useState, useEffect } from 'react';
import PortalDropdown from './shared/PortalDropdown';
import * as ipc from '../ipc';
import NumberSetting from './shared/NumberSetting';
import MasterKeySection from './MasterKeySection';
import ExportDataModal from './ExportDataModal';
import ImportDataModal from './ImportDataModal';
import { useAppStore, reportFailure } from '../store/appStore';
import { ColorPickerField } from './ColorPicker';
import { resolveAccent } from '../store/appStore';
import type { AppTheme, CursorStyle, Settings } from '../types';

/** System first: it is the one that defers rather than decides. */
const APP_THEMES: { value: AppTheme; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'dark', label: 'Dark' },
  { value: 'light', label: 'Light' },
  { value: 'amoled', label: 'AMOLED' },
];

const CURSOR_STYLES: PickerOption<CursorStyle>[] = [
  { value: 'block', label: 'Block' },
  { value: 'underline', label: 'Underline' },
  { value: 'bar', label: 'Bar' },
];

interface PickerOption<T extends string> {
  value: T;
  label: string;
}

/**
 * One dropdown, shared by the cursor style and font family fields.
 *
 * `previewFont` renders each option in the family it names, which is the whole
 * point of a font list: the names mean little until you can see them.
 */
function Picker<T extends string>({
  value,
  options,
  onChange,
  previewFont = false,
}: {
  value: T;
  options: PickerOption<T>[];
  onChange: (v: T) => void;
  previewFont?: boolean;
}) {
  const label = options.find((o) => o.value === value)?.label ?? value;

  return (
    <PortalDropdown label={label} maxHeight={280}>
      {(close) => options.map((o) => (
        <button
          key={o.value}
          type="button"
          className={`picker-item${previewFont ? ' picker-item-font' : ''}${value === o.value ? ' selected' : ''}`}
          onMouseDown={(e) => { e.preventDefault(); onChange(o.value); close(); }}
        >
          {previewFont ? (
            <>
              <span>{o.label}</span>
              <span className="picker-font-sample" style={{ fontFamily: o.value }}>AaBb0123</span>
            </>
          ) : o.label}
        </button>
      ))}
    </PortalDropdown>
  );
}

export default function SettingsPanel() {
  const { settings, saveSettings, setActiveTab, systemAppearance } = useAppStore();
  const [fonts, setFonts] = useState<string[]>([]);
  // What the picker should show: the user's colour, else the desktop's,
  // else the dark palette's own, which is what an unthemed picker opens on.
  const accent = resolveAccent(settings, systemAppearance);

  useEffect(() => {
    ipc.listFonts().then(setFonts).catch(() => setFonts([]));
  }, []);

  // `monospace` first because it is the default and the one value guaranteed to
  // resolve. A family already saved but no longer installed is kept in the list
  // rather than dropped, so opening Settings cannot silently change the setting
  // to whatever happened to be first.
  const fontOptions = [
    { value: 'monospace', label: 'monospace (system default)' },
    ...fonts.filter((f) => f !== 'monospace').map((f) => ({ value: f, label: f })),
    ...(settings.font_family && settings.font_family !== 'monospace' && !fonts.includes(settings.font_family)
      ? [{ value: settings.font_family, label: `${settings.font_family} (not installed)` }]
      : []),
  ];
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);


  function patch(p: Partial<Settings>) {
    saveSettings({ ...settings, ...p }).catch(reportFailure);
  }

  return (
    <div className="panel">
      <div className="panel-title">Settings</div>

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
                ? "Following the system accent, and changes with it."
                : 'The system exposes no accent, so the theme\u2019s own is used.'}
          </p>
        </div>
      </section>

      <section className="panel-section">
        <h3>Font</h3>
        <div className="form-row">
          <div className="form-group flex-1">
            <label>Family</label>
            <Picker
              value={settings.font_family}
              options={fontOptions}
              onChange={(v) => patch({ font_family: v })}
              previewFont
            />
          </div>
          <div className="form-group port-group">
            <label>Size</label>
            <input
              type="number"
              className="no-spinner"
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
          <Picker value={settings.cursor_style} options={CURSOR_STYLES} onChange={(v) => patch({ cursor_style: v })} />
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
        <NumberSetting
          label="Global timeout (seconds)"
          value={settings.connection_timeout_secs}
          min={1}
          max={3600}
          onCommit={(v) => patch({ connection_timeout_secs: v })}
        />
        <p className="form-hint">Connection attempt timeout. Per-host timeout can be set in host settings and overrides this value.</p>
        <NumberSetting
          label="SFTP inactivity timeout (seconds)"
          value={settings.sftp_inactivity_timeout_secs}
          min={30}
          max={86400}
          onCommit={(v) => patch({ sftp_inactivity_timeout_secs: v })}
        />
        <p className="form-hint">How long an idle SFTP session is kept alive.</p>
        <NumberSetting
          label="Keepalive interval (seconds)"
          value={settings.keepalive_interval_secs}
          min={0}
          max={3600}
          onCommit={(v) => patch({ keepalive_interval_secs: v })}
        />
        <p className="form-hint">
          Sends a periodic keepalive on terminal sessions and tunnels so they are not dropped by
          a NAT or firewall idle timer, and so a dead connection is noticed rather than hanging.
          A connection is considered lost after three unanswered keepalives. Set to 0 to disable.
          Does not apply to SFTP, which uses the inactivity timeout above instead.
        </p>
      </section>

      <section className="panel-section">
        <h3>Host keys</h3>
        <p className="form-hint form-hint-flush">
          Server fingerprints and how new servers are trusted are managed on the{' '}
          <button type="button" className="link-btn" onClick={() => setActiveTab('knownhosts')}>
            Known Hosts
          </button>{' '}
          page.
        </p>
      </section>

      <MasterKeySection />

      <section className="panel-section">
        <h3>Backup and transfer</h3>
        <p className="form-hint form-hint-flush">
          Everything saved here goes into one file: hosts, identities, keys, tunnels, codeprints,
          themes, settings and known hosts. It is encrypted under a passphrase you choose for it,
          separate from your master key, which is what lets it open on another machine. Importing
          only adds; anything already here is kept.
        </p>
        <div className="transfer-buttons">
          <button className="btn-secondary" onClick={() => setExporting(true)}>Export…</button>
          <button className="btn-secondary" onClick={() => setImporting(true)}>Import…</button>
        </div>
      </section>

      {exporting && <ExportDataModal onClose={() => setExporting(false)} />}
      {importing && <ImportDataModal onClose={() => setImporting(false)} />}

      <section className="panel-section">
        <h3>Interface</h3>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.show_hover_hints}
            onChange={(e) => patch({ show_hover_hints: e.target.checked })}
          />
          <span>Show hover hints</span>
        </label>
        <p className="form-hint">Toggles hints while hovering.</p>
      </section>
    </div>
  );
}
