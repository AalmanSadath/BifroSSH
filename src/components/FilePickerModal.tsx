import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { FileEntry } from '../types';

interface Props {
  /** `save` asks for a name to write; `open` asks for a file that exists. */
  mode: 'save' | 'open';
  title: string;
  /** Where to start. Falls back to the home directory when absent or unreadable. */
  startDir?: string;
  /** Prefilled name, `save` only. */
  defaultName?: string;
  /** Extensions worth showing, e.g. `['.bfx']`. Everything else is dimmed. */
  extensions?: string[];
  onCancel: () => void;
  onChoose: (path: string) => void;
}

/**
 * A local file picker built on the same two commands the SFTP panel's local
 * pane uses.
 *
 * Deliberately not a native dialog: the alternative costs a plugin, a
 * capability entry and a regeneration of both offline dependency manifests
 * that the Flatpak build reads, all to browse a filesystem this app can
 * already list.
 */
export default function FilePickerModal({
  mode,
  title,
  startDir,
  defaultName,
  extensions,
  onCancel,
  onChoose,
}: Props) {
  const [dir, setDir] = useState('');
  const [typedPath, setTypedPath] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [name, setName] = useState(defaultName ?? '');
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const nameRef = useRef<HTMLInputElement>(null);

  const matches = (entry: FileEntry) =>
    !extensions || extensions.some((ext) => entry.name.toLowerCase().endsWith(ext));

  /** In save mode only folders can be picked; the name comes from the field. */
  const selectable = (entry: FileEntry) => entry.is_dir || (mode === 'open' && matches(entry));

  async function navigate(path: string) {
    setLoading(true);
    try {
      const listed = await invoke<FileEntry[]>('sftp_list_local', { path });
      setEntries(listed);
      setDir(path);
      setTypedPath(path);
      setSelected(null);
      setError('');
    } catch (e) {
      // The previous listing stays on screen: a directory we cannot read is a
      // dead end, not a reason to empty the window the user is navigating in.
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    (async () => {
      const home = await invoke<string>('sftp_local_home').catch(() => '/');
      await navigate(startDir || home);
      if (mode === 'save') nameRef.current?.select();
    })();
    // Mount only: later prop changes would yank the user out of the folder
    // they had navigated to.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On the window rather than the overlay: the overlay never takes focus, so a
  // handler on it only fires once something inside it happens to be focused.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  function activate(entry: FileEntry) {
    if (entry.is_dir) {
      navigate(entry.path);
    } else if (mode === 'open' && matches(entry)) {
      onChoose(entry.path);
    }
  }

  function click(entry: FileEntry) {
    if (entry.is_dir) {
      setSelected(entry.path);
    } else if (mode === 'open' && matches(entry)) {
      setSelected(entry.path);
    } else if (mode === 'save' && !entry.is_dir) {
      // Clicking an existing file in save mode is how people say "overwrite
      // this one", so it fills the name rather than doing nothing.
      setName(entry.name);
    }
  }

  function confirm() {
    if (mode === 'open') {
      if (selected) onChoose(selected);
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) return;
    // A folder highlighted in save mode is a target to write into, not the
    // file itself, so the name is always appended to the directory shown.
    const base = (selected && entries.find((e) => e.path === selected)?.is_dir ? selected : dir)
      .replace(/\/+$/, '');
    onChoose(`${base}/${trimmed}`);
  }

  const canConfirm = mode === 'open' ? Boolean(selected) : name.trim().length > 0;

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal picker-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{title}</h2>
        </div>

        <input
          className="picker-path"
          value={typedPath}
          spellCheck={false}
          aria-label="Current folder"
          onChange={(e) => setTypedPath(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') navigate(typedPath.trim());
          }}
        />

        {error && <p className="form-hint" style={{ color: 'var(--danger)' }}>{error}</p>}

        <div className="picker-list">
          {loading && entries.length === 0 ? (
            <p className="form-hint">Reading…</p>
          ) : (
            entries.map((entry) => (
              <div
                key={entry.path}
                className={[
                  'picker-row',
                  selectable(entry) ? '' : 'picker-row-dim',
                  selected === entry.path ? 'picker-row-selected' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => click(entry)}
                onDoubleClick={() => activate(entry)}
              >
                <span className="picker-icon">{entry.is_dir ? '📁' : '📄'}</span>
                <span className="picker-name">{entry.name}</span>
              </div>
            ))
          )}
        </div>

        {mode === 'save' && (
          <div className="picker-name-row">
            <label htmlFor="picker-filename">File</label>
            <input
              id="picker-filename"
              ref={nameRef}
              value={name}
              spellCheck={false}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canConfirm) confirm();
              }}
            />
          </div>
        )}

        <div className="modal-actions">
          <button className="btn-secondary" onClick={onCancel}>Cancel</button>
          <button className="btn-primary" onClick={confirm} disabled={!canConfirm}>
            {mode === 'save' ? 'Save here' : 'Open'}
          </button>
        </div>
      </div>
    </div>
  );
}
