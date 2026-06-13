import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '../store/appStore';
import type { Settings } from '../types';

const CURSOR_STYLES = [
  { value: 'block', label: 'Block' },
  { value: 'underline', label: 'Underline' },
  { value: 'bar', label: 'Bar' },
];

function CursorStylePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const label = CURSOR_STYLES.find((s) => s.value === value)?.label ?? value;

  function openPicker() {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setRect({ top: r.bottom + 2, left: r.left, width: r.width });
    setOpen(true);
  }

  return (
    <>
      <button ref={btnRef} type="button" className="picker-btn" onClick={openPicker}>
        <span>{label}</span>
        <svg width="10" height="6" viewBox="0 0 10 6" fill="currentColor"><path d="M0 0l5 6 5-6z"/></svg>
      </button>
      {open && rect && createPortal(
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onMouseDown={() => setOpen(false)} />
          <div className="picker-menu" style={{ position: 'fixed', top: rect.top, left: rect.left, width: rect.width, zIndex: 9999 }}>
            {CURSOR_STYLES.map((s) => (
              <button
                key={s.value}
                type="button"
                className={`picker-item${value === s.value ? ' selected' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); onChange(s.value); setOpen(false); }}
              >
                {s.label}
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}

export default function SettingsPanel() {
  const { settings, saveSettings } = useAppStore();
  const [connTimeoutStr, setConnTimeoutStr] = useState(String(settings.connection_timeout_secs));
  const [sftpTimeoutStr, setSftpTimeoutStr] = useState(String(settings.sftp_inactivity_timeout_secs));

  useEffect(() => { setConnTimeoutStr(String(settings.connection_timeout_secs)); }, [settings.connection_timeout_secs]);
  useEffect(() => { setSftpTimeoutStr(String(settings.sftp_inactivity_timeout_secs)); }, [settings.sftp_inactivity_timeout_secs]);

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
          <CursorStylePicker value={settings.cursor_style} onChange={(v) => patch({ cursor_style: v })} />
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
            value={connTimeoutStr}
            onChange={(e) => setConnTimeoutStr(e.target.value)}
            onBlur={() => {
              const v = Math.min(3600, Math.max(1, Number(connTimeoutStr) || 1));
              setConnTimeoutStr(String(v));
              patch({ connection_timeout_secs: v });
            }}
            style={{ width: 80 }}
            className="no-spinner"
          />
        </div>
        <p className="form-hint">Connection attempt timeout. Per-host timeout can be set in host settings and overrides this value.</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
          <label style={{ margin: 0, whiteSpace: 'nowrap' }}>SFTP inactivity timeout (seconds)</label>
          <input
            type="number"
            min={30}
            max={86400}
            value={sftpTimeoutStr}
            onChange={(e) => setSftpTimeoutStr(e.target.value)}
            onBlur={() => {
              const v = Math.min(86400, Math.max(30, Number(sftpTimeoutStr) || 30));
              setSftpTimeoutStr(String(v));
              patch({ sftp_inactivity_timeout_secs: v });
            }}
            style={{ width: 80 }}
            className="no-spinner"
          />
        </div>
        <p className="form-hint">How long an idle SFTP session is kept alive.</p>
      </section>

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
