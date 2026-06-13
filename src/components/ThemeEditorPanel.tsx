import { Fragment, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '../store/appStore';
import { THEMES } from '../styles/themes';
import type { NamedTheme } from '../styles/themes';
import { ColorPickerField } from './ColorPicker';

interface ThemeColors {
  background: string; foreground: string; cursor: string;
  cursorAccent: string; selectionBackground: string;
  black: string; red: string; green: string; yellow: string;
  blue: string; magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string;
  brightYellow: string; brightBlue: string; brightMagenta: string;
  brightCyan: string; brightWhite: string;
}

type ColorKey = keyof ThemeColors;

const DEFAULT_COLORS: ThemeColors = {
  background: '#0d1117', foreground: '#e6edf3', cursor: '#58a6ff',
  cursorAccent: '#0d1117', selectionBackground: '#3d444d',
  black: '#21262d', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
  blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39c5cf', white: '#b1bac4',
  brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364',
  brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd', brightWhite: '#f0f6fc',
};

const MAIN_FIELDS: { key: ColorKey; label: string }[] = [
  { key: 'background', label: 'Background' },
  { key: 'foreground', label: 'Foreground' },
  { key: 'cursor', label: 'Cursor' },
  { key: 'cursorAccent', label: 'Cursor Accent' },
  { key: 'selectionBackground', label: 'Selection' },
];

const ANSI_PAIRS: { label: string; normal: ColorKey; bright: ColorKey }[] = [
  { label: 'Black',   normal: 'black',   bright: 'brightBlack'   },
  { label: 'Red',     normal: 'red',     bright: 'brightRed'     },
  { label: 'Green',   normal: 'green',   bright: 'brightGreen'   },
  { label: 'Yellow',  normal: 'yellow',  bright: 'brightYellow'  },
  { label: 'Blue',    normal: 'blue',    bright: 'brightBlue'    },
  { label: 'Magenta', normal: 'magenta', bright: 'brightMagenta' },
  { label: 'Cyan',    normal: 'cyan',    bright: 'brightCyan'    },
  { label: 'White',   normal: 'white',   bright: 'brightWhite'   },
];

function themeToColors(t: NamedTheme): ThemeColors {
  return {
    background: t.background ?? DEFAULT_COLORS.background,
    foreground: t.foreground ?? DEFAULT_COLORS.foreground,
    cursor: t.cursor ?? DEFAULT_COLORS.cursor,
    cursorAccent: t.cursorAccent ?? DEFAULT_COLORS.cursorAccent,
    selectionBackground: t.selectionBackground ?? DEFAULT_COLORS.selectionBackground,
    black: t.black ?? DEFAULT_COLORS.black,
    red: t.red ?? DEFAULT_COLORS.red,
    green: t.green ?? DEFAULT_COLORS.green,
    yellow: t.yellow ?? DEFAULT_COLORS.yellow,
    blue: t.blue ?? DEFAULT_COLORS.blue,
    magenta: t.magenta ?? DEFAULT_COLORS.magenta,
    cyan: t.cyan ?? DEFAULT_COLORS.cyan,
    white: t.white ?? DEFAULT_COLORS.white,
    brightBlack: t.brightBlack ?? DEFAULT_COLORS.brightBlack,
    brightRed: t.brightRed ?? DEFAULT_COLORS.brightRed,
    brightGreen: t.brightGreen ?? DEFAULT_COLORS.brightGreen,
    brightYellow: t.brightYellow ?? DEFAULT_COLORS.brightYellow,
    brightBlue: t.brightBlue ?? DEFAULT_COLORS.brightBlue,
    brightMagenta: t.brightMagenta ?? DEFAULT_COLORS.brightMagenta,
    brightCyan: t.brightCyan ?? DEFAULT_COLORS.brightCyan,
    brightWhite: t.brightWhite ?? DEFAULT_COLORS.brightWhite,
  };
}

const ColorField = ColorPickerField;

function PresetDropdown({ allThemes, customThemes, onSelect }: {
  allThemes: Record<string, NamedTheme>;
  customThemes: Record<string, NamedTheme>;
  onSelect: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('— Select a theme —');
  const btnRef = useRef<HTMLButtonElement>(null);
  const [rect, setRect] = useState<{ top: number; left: number; width: number; maxHeight: number } | null>(null);
  const builtIn = Object.entries(allThemes).filter(([id]) => !customThemes[id]);
  const custom = Object.entries(customThemes);

  function pick(id: string, name: string) {
    setLabel(name);
    setOpen(false);
    onSelect(id);
  }

  function openDropdown() {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setRect({ top: r.bottom + 2, left: r.left, width: r.width, maxHeight: window.innerHeight - r.bottom - 12 });
    setOpen(true);
  }

  return (
    <>
      <button ref={btnRef} type="button" className="picker-btn" onClick={openDropdown}>
        <span>{label}</span>
        <svg width="10" height="6" viewBox="0 0 10 6" fill="currentColor"><path d="M0 0l5 6 5-6z"/></svg>
      </button>
      {open && rect && createPortal(
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onMouseDown={() => setOpen(false)} />
          <div className="picker-menu" style={{ position: 'fixed', top: rect.top, left: rect.left, width: rect.width, maxHeight: rect.maxHeight, zIndex: 9999 }}>
            {builtIn.length > 0 && <div className="te-preset-group-label">Built-in</div>}
            {builtIn.map(([id, t]) => (
              <button key={id} type="button" className="picker-item" onMouseDown={(e) => { e.preventDefault(); pick(id, t.name); }}>{t.name}</button>
            ))}
            {custom.length > 0 && <><div className="picker-divider" /><div className="te-preset-group-label">Custom</div></>}
            {custom.map(([id, t]) => (
              <button key={id} type="button" className="picker-item" onMouseDown={(e) => { e.preventDefault(); pick(id, t.name); }}>{t.name}</button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}

function TerminalPreview({ colors }: { colors: ThemeColors }) {
  const { settings } = useAppStore();
  const hint = (t: string) => settings.show_hover_hints ? t : undefined;
  const { background, foreground, cursor, green, blue, red, yellow,
    brightBlack, brightBlue, brightRed, magenta, cyan, white, black,
    brightGreen, brightYellow, brightMagenta, brightCyan, brightWhite } = colors;

  const swatchNormal = [black, red, green, yellow, blue, magenta, cyan, white];
  const swatchBright = [brightBlack, brightRed, brightGreen, brightYellow, brightBlue, brightMagenta, brightCyan, brightWhite];

  return (
    <div className="te-preview-window">
      <div className="te-preview-titlebar">
        <span className="te-dot" style={{ background: '#ff5f57' }} />
        <span className="te-dot" style={{ background: '#ffbd2e' }} />
        <span className="te-dot" style={{ background: '#28c841' }} />
        <span className="te-preview-title-text">bifrossh — bash</span>
      </div>
      <div className="te-preview-terminal" style={{ background, color: foreground }}>
        <div>
          <span style={{ color: green }}>user@host</span>
          <span style={{ color: foreground }}>:~$ </span>
          <span>ls -la</span>
        </div>
        <div><span style={{ color: brightBlack }}>total 32</span></div>
        <div>
          <span style={{ color: blue }}>drwxr-xr-x</span>
          <span> 5 user  </span>
          <span style={{ color: brightBlue }}>Documents/</span>
        </div>
        <div>
          <span>-rw-r--r-- 1 user  </span>
          <span style={{ color: yellow }}>notes.txt</span>
        </div>
        <div>
          <span style={{ color: cyan }}>-rw-r--r-- 1 user  </span>
          <span style={{ color: magenta }}>script.sh</span>
        </div>
        <div>
          <span style={{ color: green }}>user@host</span>
          <span>:~$ cat missing.txt</span>
        </div>
        <div>
          <span style={{ color: red }}>cat: </span>
          <span style={{ color: brightRed }}>No such file or directory</span>
        </div>
        <div>
          <span style={{ color: green }}>user@host</span>
          <span>:~$ </span>
          <span className="te-cursor" style={{ background: cursor, color: background }}>█</span>
        </div>
      </div>
      <div className="te-swatches-row">
        {swatchNormal.map((c, i) => (
          <div key={i} className="te-swatch" style={{ background: c }} title={hint(['Black','Red','Green','Yellow','Blue','Magenta','Cyan','White'][i])} />
        ))}
      </div>
      <div className="te-swatches-row">
        {swatchBright.map((c, i) => (
          <div key={i} className="te-swatch" style={{ background: c }} title={hint(['Bright Black','Bright Red','Bright Green','Bright Yellow','Bright Blue','Bright Magenta','Bright Cyan','Bright White'][i])} />
        ))}
      </div>
    </div>
  );
}

function SavedThemeCard({ theme, onEdit, onDelete, active }: {
  theme: NamedTheme;
  onEdit: () => void; onDelete: () => void; active: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const bars = [
    { color: theme.green, width: '72%' },
    { color: theme.foreground, width: '55%' },
    { color: theme.red, width: '40%' },
    { color: theme.yellow, width: '60%' },
    { color: theme.cyan, width: '30%' },
    { color: theme.blue, width: '48%' },
  ];

  return (
    <div className={`te-saved-card${active ? ' te-saved-card-active' : ''}`}>
      <div className="te-saved-thumb-wrap">
        <div className="theme-thumb" style={{ background: theme.background ?? '#000' }}>
          <div className="theme-thumb-bars">
            {bars.map((b, i) => (
              <div key={i} className="theme-thumb-bar" style={{ background: b.color, width: b.width }} />
            ))}
          </div>
          <div className="theme-thumb-cursor" style={{ background: theme.cursor ?? theme.foreground ?? '#fff' }} />
        </div>
      </div>
      <span className="te-saved-name">{theme.name}</span>
      <div className="te-saved-actions">
        {confirming ? (
          <>
            <span className="te-delete-confirm-text">Delete?</span>
            <button className="btn-danger btn-sm" onClick={onDelete}>Yes</button>
            <button className="btn-secondary btn-sm" onClick={() => setConfirming(false)}>No</button>
          </>
        ) : (
          <>
            <button className="btn-secondary btn-sm" onClick={onEdit}>Edit</button>
            <button className="btn-danger btn-sm" onClick={() => setConfirming(true)}>Delete</button>
          </>
        )}
      </div>
    </div>
  );
}

export default function ThemeEditorPanel() {
  const { customThemes, saveCustomTheme, deleteCustomTheme } = useAppStore();
  const [colors, setColors] = useState<ThemeColors>({ ...DEFAULT_COLORS });
  const [name, setName] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [nameError, setNameError] = useState('');

  const allThemes = { ...THEMES, ...customThemes };

  function loadPreset(id: string) {
    const t = allThemes[id];
    if (t) setColors(themeToColors(t));
  }

  function startEdit(id: string) {
    const t = customThemes[id];
    if (!t) return;
    setColors(themeToColors(t));
    setName(t.name);
    setEditingId(id);
    setNameError('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function resetEditor() {
    setColors({ ...DEFAULT_COLORS });
    setName('');
    setEditingId(null);
    setNameError('');
  }

  function handleSave() {
    const trimmed = name.trim();
    if (!trimmed) { setNameError('Theme name is required'); return; }
    const id = editingId ?? `custom-${Date.now()}`;
    saveCustomTheme(id, { name: trimmed, ...colors });
    resetEditor();
  }

  function setColor(key: ColorKey, val: string) {
    setColors((c) => ({ ...c, [key]: val }));
  }

  return (
    <div className="panel te-panel">
      <div className="panel-title-row">
        <div className="panel-title">Theme Editor</div>
      </div>

      <div className="te-editor-layout">
        {/* Left: name + preset + preview */}
        <div className="te-preview-col">
          <div className="form-group" style={{ marginBottom: 10 }}>
            <label>Theme Name</label>
            <input
              className="te-name-input"
              value={name}
              onChange={(e) => { setName(e.target.value); setNameError(''); }}
              placeholder="My Custom Theme…"
              onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
            />
            {nameError && <p className="form-error" style={{ margin: '4px 0 0' }}>{nameError}</p>}
          </div>
          <div className="form-group" style={{ marginBottom: 12 }}>
            <label>Copy from preset</label>
            <PresetDropdown allThemes={allThemes} customThemes={customThemes} onSelect={loadPreset} />
          </div>
          <TerminalPreview colors={colors} />
        </div>

        {/* Right: color fields + save */}
        <div className="te-controls-col">
          <div className="te-section-label">Main Colors</div>
          {MAIN_FIELDS.map(({ key, label }) => (
            <div key={key} className="te-color-row">
              <span className="te-color-label">{label}</span>
              <ColorField value={colors[key]} onChange={(v) => setColor(key, v)} />
            </div>
          ))}

          <div className="te-section-label" style={{ marginTop: 16 }}>ANSI Colors</div>
          <div className="te-ansi-grid">
            <div />
            <span className="te-ansi-col-header">Normal</span>
            <span className="te-ansi-col-header">Bright</span>
            {ANSI_PAIRS.map(({ label, normal, bright }) => (
              <Fragment key={label}>
                <span className="te-ansi-label">{label}</span>
                <ColorField value={colors[normal]} onChange={(v) => setColor(normal, v)} />
                <ColorField value={colors[bright]} onChange={(v) => setColor(bright, v)} />
              </Fragment>
            ))}
          </div>

          <div className="te-save-row">
            {editingId && (
              <button className="btn-secondary btn-sm" onClick={resetEditor}>Cancel</button>
            )}
            <button className="btn-primary btn-sm" style={{ marginLeft: 'auto' }} onClick={handleSave}>
              {editingId ? 'Update Theme' : 'Save Theme'}
            </button>
          </div>
        </div>
      </div>

      {/* Saved custom themes */}
      {Object.keys(customThemes).length > 0 && (
        <section className="panel-section">
          <h3>Saved Custom Themes</h3>
          <div className="te-saved-list">
            {Object.entries(customThemes).map(([id, t]) => (
              <SavedThemeCard
                key={id}
                theme={t}
                active={editingId === id}
                onEdit={() => startEdit(id)}
                onDelete={() => { deleteCustomTheme(id); if (editingId === id) resetEditor(); }}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
