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
          <p className="form-hint">
            Used by every host that has no theme of its own, and offered as the
            starting point when a host is added.
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
        <NumberSetting
          label="Scrollback (lines)"
          value={settings.scrollback_lines}
          min={1000}
          max={1000000}
          onCommit={(v) => patch({ scrollback_lines: v })}
        />
        <p className="form-hint">
          How much output a terminal keeps above the screen. Applies to open tabs as well;
          lowering it drops what is beyond the new limit.
        </p>
      </section>

      <section className="panel-section">
        <h3>Shell integration</h3>
        <p className="form-hint">
          A tab can show what its shell is running, and how the last command ended, once the
          shell marks the start and end of each command. Stock servers send nothing, so the
          line below has to be added to the shell first: paste it into a session to try it,
          or put it in a host's Run on Connect to have it every time.
        </p>
        <div className="shell-integration-row">
          {SHELLS.map(({ id, label }) => (
            <button
              key={id}
              className="sftp-action-btn"
              onClick={() => void copy(snippetFor(id), id)}
            >
              {copied === id ? 'Copied' : failed ? 'Copy failed' : `Copy for ${label}`}
            </button>
          ))}
        </div>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.autosuggest}
            onChange={(e) => patch({ autosuggest: e.target.checked })}
          />
          <span>Suggest commands from history</span>
        </label>
        <p className="form-hint">
          With the line above in place, commands run at a prompt on a saved host are remembered
          for that host, and typing the start of one shows the rest in grey; Right arrow at the
          end of the line takes it. A command typed with a leading space is never remembered.
          History is kept encrypted with everything else and is not part of an export.
        </p>
        <div className="settings-inline-row">
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
