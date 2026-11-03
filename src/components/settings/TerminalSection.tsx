import { useEffect, useState } from 'react';
import * as ipc from '../../ipc';
import { useAppStore, reportFailure } from '../../store/appStore';
import NumberSetting from '../shared/NumberSetting';
import ThemePicker, { ThumbNail } from '../ThemePicker';
import { THEMES } from '../../styles/themes';
import { Picker, usePatch, type PickerOption } from './Picker';
import { useCopy } from '../shared/useCopy';
import HighlightRules from './HighlightRules';
import { SHELLS, snippetFor } from '../../shellIntegration';
import type { CursorStyle } from '../../types';
import { isAndroid } from '../../platform';

const CURSOR_STYLES: PickerOption<CursorStyle>[] = [
  { value: 'block', label: 'Block' },
  { value: 'underline', label: 'Underline' },
  { value: 'bar', label: 'Bar' },
];

/** Everything about the terminal itself: its colours, its type and its cursor. */
export default function TerminalSection() {
  const { settings, customThemes, clearCommandHistory } = useAppStore();
  const [historyCleared, setHistoryCleared] = useState(false);
  const patch = usePatch();
  const [localShellDraft, setLocalShellDraft] = useState(settings.local_shell);
  useEffect(() => { setLocalShellDraft(settings.local_shell); }, [settings.local_shell]);
  const [themeExpanded, setThemeExpanded] = useState(false);
  const [fonts, setFonts] = useState<string[]>([]);
  // Keyed by shell, so the button that was pressed is the one that says so.
  const { copied, failed, copy } = useCopy();

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

  return (
    <>
      <section className="panel-section">
        <h3>Theme</h3>
        {/* The terminal colours every host starts from. Only ever writable
            through the data file before this: the picker existed on a host
            and on a session, but not on the setting both fall back to. */}
        <div className="form-group">
          <label>Terminal Theme</label>
          <div className="theme-current-row">
            <div className="theme-current-thumb">
              <ThumbNail id={settings.theme} />
            </div>
            <span className="theme-current-name">
              {(THEMES[settings.theme] ?? customThemes[settings.theme])?.name ?? settings.theme}
            </span>
          </div>
          <button
            type="button"
            className="theme-show-more-btn"
            onClick={() => setThemeExpanded((v) => !v)}
          >
            {themeExpanded ? 'Show less ∧' : 'Show more ∨'}
          </button>
          {themeExpanded && (
            <ThemePicker
              value={settings.theme}
              onChange={(id) => { patch({ theme: id }); setThemeExpanded(false); }}
            />
          )}
          <p className="form-hint">Default for hosts without their own theme.</p>
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
        <NumberSetting
          label="Scrollback (lines)"
          value={settings.scrollback_lines}
          min={1000}
          max={1000000}
          onCommit={(v) => patch({ scrollback_lines: v })}
        />
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.inline_images}
            onChange={(e) => patch({ inline_images: e.target.checked })}
          />
          <span>Show images in the terminal</span>
        </label>
        <p className="form-hint">Sixel and iTerm2 images, from tools like imgcat or chafa.</p>
        {isAndroid && (
          <>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={settings.volume_keys_zoom}
                onChange={(e) => patch({ volume_keys_zoom: e.target.checked })}
              />
              <span>Volume keys change the text size</span>
            </label>
            <p className="form-hint">Only while a terminal is in front.</p>
          </>
        )}
      </section>

      <section className="panel-section">
        <h3>Shell integration</h3>
        <div className="settings-actions">
          {SHELLS.map(({ id, label }) => (
            <button
              key={id}
              className="btn-secondary btn-sm"
              onClick={() => void copy(snippetFor(id), id)}
            >
              {copied === id ? 'Copied' : failed ? 'Copy failed' : `Copy for ${label}`}
            </button>
          ))}
        </div>
        <p className="form-hint">Add this to the shell (or Run on Connect) to see command status.</p>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.autosuggest}
            onChange={(e) => patch({ autosuggest: e.target.checked })}
          />
          <span>Suggest commands from history</span>
        </label>
        <p className="form-hint">Needs the line above. A leading space keeps a command out.</p>
        <div className="settings-actions">
          <button
            className="btn-secondary btn-sm"
            onClick={() => {
              clearCommandHistory(null).then(() => setHistoryCleared(true)).catch(reportFailure);
            }}
          >
            Clear all command history
          </button>
          {historyCleared && <span className="form-hint form-hint-flush">Cleared</span>}
        </div>
      </section>

      <section className="panel-section">
        <h3>Monitor bar</h3>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.monitor_bar}
            onChange={(e) => patch({ monitor_bar: e.target.checked })}
          />
          <span>Show a monitor bar under terminals</span>
        </label>
        <p className="form-hint">CPU, memory, disk and network for Linux hosts.</p>
      </section>

      {!isAndroid && <section className="panel-section">
        <h3>Local shell</h3>
        <div className="form-group">
          <label>Command</label>
          <input
            type="text"
            value={localShellDraft}
            placeholder="The system's own"
            onChange={(e) => setLocalShellDraft(e.target.value)}
            onBlur={() => patch({ local_shell: localShellDraft.trim() })}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            spellCheck={false}
          />
        </div>
        <p className="form-hint">Empty uses your login shell (PowerShell on Windows).</p>
      </section>}

      <HighlightRules />

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
    </>
  );
}
