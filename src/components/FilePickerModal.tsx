import { useEffect, useRef, useState } from 'react';
import * as ipc from '../ipc';
import { localStyle } from '../paths';
import type { FileEntry } from '../types';
import Modal from './shared/Modal';

interface Props {
  /**
   * `save` asks for a name to write; `open` asks for a file that exists;
   * `folder` asks for a folder, the one highlighted or else the one shown.
   */
  mode: 'save' | 'open' | 'folder';
  title: string;
  /** Where to start. Falls back to the home directory when absent or unreadable. */
  startDir?: string;
  /** Prefilled name, `save` only. */
  defaultName?: string;
  /** Extensions worth showing, e.g. `['.bfx']`. Everything else is dimmed. */
  extensions?: string[];
  onCancel: () => void;
  /** Called with one path, or, with `multiple`, with each chosen in turn by `onChooseMany`. */
  onChoose?: (path: string) => void;
  /** `open` only: any number of files, each clicked on or off, handed over together. */
  multiple?: boolean;
  onChooseMany?: (paths: string[]) => void;
  /** Wording for the confirm button, when the mode's own does not fit. */
  confirmLabel?: string;
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
  multiple,
  onChooseMany,
  confirmLabel,
}: Props) {
  const [dir, setDir] = useState('');
  const [typedPath, setTypedPath] = useState('');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [name, setName] = useState(defaultName ?? '');
  const [selected, setSelected] = useState<string | null>(null);
  /** With `multiple`: the files ticked so far, kept across folders. */
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const nameRef = useRef<HTMLInputElement>(null);

  const matches = (entry: FileEntry) =>
    !extensions || extensions.some((ext) => entry.name.toLowerCase().endsWith(ext));

  /**
   * The extension the caller asked for, added when the typed name has none of
   * them. Every save dialog does this, and without it a name typed over the
   * suggested one produced a file the app itself would not offer to open
   * again, because `matches` filters on exactly these.
   */
  const withExtension = (typed: string) => {
    if (!typed || !extensions?.length) return typed;
    const has = extensions.some((ext) => typed.toLowerCase().endsWith(ext));
    return has ? typed : typed + extensions[0];
  };

  /** In save and folder mode only folders can be picked; a name comes from the field. */
  const selectable = (entry: FileEntry) => entry.is_dir || (mode === 'open' && matches(entry));

  async function navigate(path: string) {
    setLoading(true);
    try {
      const listed = await ipc.sftpListLocal(path);
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
      const home = await ipc.sftpLocalHome().catch(() => localStyle().defaultRoot);
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
      if (multiple) togglePicked(entry.path);
      else onChoose?.(entry.path);
    }
  }

  function togglePicked(path: string) {
    setPicked((p) => (p.includes(path) ? p.filter((x) => x !== path) : [...p, path]));
  }

  function click(entry: FileEntry) {
    if (entry.is_dir) {
      setSelected(entry.path);
    } else if (mode === 'open' && matches(entry)) {
      if (multiple) togglePicked(entry.path);
      else setSelected(entry.path);
    } else if (mode === 'save' && !entry.is_dir) {
      // Clicking an existing file in save mode is how people say "overwrite
      // this one", so it fills the name rather than doing nothing.
      setName(entry.name);
    }
  }

  function confirm() {
    if (mode === 'open') {
      if (multiple) { if (picked.length > 0) onChooseMany?.(picked); }
      else if (selected) onChoose?.(selected);
      return;
    }
    if (mode === 'folder') {
      const folder = selected && entries.find((e) => e.path === selected)?.is_dir && !selected.endsWith('..') ? selected : dir;
      onChoose?.(folder);
      return;
    }
    const trimmed = withExtension(name.trim());
    if (!trimmed) return;
    // A folder highlighted in save mode is a target to write into, not the
    // file itself, so the name is always appended to the directory shown.
    const base = selected && entries.find((e) => e.path === selected)?.is_dir ? selected : dir;
    onChoose?.(localStyle().join(base, trimmed));
  }

  /**
   * Hidden files are left out, with no toggle to bring them back: this picker
   * exists to choose somewhere to put a file, and a hidden one is not it. On
   * Windows that matters more than it sounds, because every folder Windows has
   * customised holds a desktop.ini.
   */
  const shown = entries.filter((e) => e.name === '..' || !e.hidden);

  const canConfirm = mode === 'open'
    ? (multiple ? picked.length > 0 : Boolean(selected))
    : mode === 'folder' ? dir !== '' : name.trim().length > 0;

  return (
    <Modal title={title} onClose={onCancel}>
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

      {error && <p className="form-hint form-hint-error">{error}</p>}

      <div className="picker-list">
        {loading && shown.length === 0 ? (
          <p className="form-hint">Reading…</p>
        ) : (
          shown.map((entry) => (
            <div
              key={entry.path}
              className={[
                'picker-row',
                selectable(entry) ? '' : 'picker-row-dim',
                selected === entry.path || picked.includes(entry.path) ? 'picker-row-selected' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => click(entry)}
              onDoubleClick={() => activate(entry)}
            >
              <span className="picker-icon">{entry.is_dir ? '📁' : picked.includes(entry.path) ? '☑' : '📄'}</span>
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
        {multiple && picked.length > 0 && (
          <span className="form-hint picker-count">{picked.length} {picked.length === 1 ? 'file' : 'files'} chosen</span>
        )}
        <button className="btn-secondary" onClick={onCancel}>Cancel</button>
        <button className="btn-primary" onClick={confirm} disabled={!canConfirm}>
          {confirmLabel ?? (mode === 'save' ? 'Save here' : mode === 'folder' ? 'Choose folder' : 'Open')}
        </button>
      </div>
    </Modal>
  );
}
