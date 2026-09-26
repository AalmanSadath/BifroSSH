import { useCallback, useEffect, useState } from 'react';
import * as ipc from '../ipc';
import { useAppStore, reportFailure } from '../store/appStore';
import { useHint } from './shared/useHint';
import { recordingName, sortRecordings } from '../asciicast';
import { formatSize } from '../transferStatus';
import type { FileEntry } from '../types';
import CastPlayer from './CastPlayer';
import ConfirmModal from './shared/ConfirmModal';
import ContextMenu from './shared/ContextMenu';
import FilePickerModal from './FilePickerModal';
import { cardKeys } from './shared/cardKeys';

function FolderIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 7h16" />
      <path d="M10 11v6M14 11v6" />
      <path d="M6 7l1 12a2 2 0 002 2h6a2 2 0 002-2l1-12" />
      <path d="M9 7V4h6v3" />
    </svg>
  );
}

const when = (d: Date) => d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/**
 * Recordings kept in the recordings folder, and the player for them.
 *
 * The folder is listed rather than tracked: a recording is a file the user
 * may move, copy in or delete behind the app's back, and the folder is the
 * truth about what is there. Anything elsewhere is opened with Open file.
 */
export default function RecordingsPanel() {
  const { playingRecording, playRecording, savedRecording } = useAppStore();
  const hint = useHint();
  const [dir, setDir] = useState<string | null>(null);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [picking, setPicking] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; file: FileEntry } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<FileEntry | null>(null);

  const refresh = useCallback(async () => {
    try {
      const folder = await ipc.recordingDir();
      setDir(folder);
      const entries = await ipc.sftpListLocal(folder);
      setFiles(sortRecordings(entries.filter((e) => !e.is_dir && e.name.toLowerCase().endsWith('.cast'))));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // Again when a recording has just been saved, so it is in the list
  // without anyone pressing Refresh.
  useEffect(() => { void refresh(); }, [refresh, savedRecording]);

  const q = query.trim().toLowerCase();
  const shown = files.filter((f) => q === '' || recordingName(f.name).label.toLowerCase().includes(q));

  async function remove(file: FileEntry) {
    setConfirmDelete(null);
    try {
      await ipc.sftpDeleteLocal(file.path);
      if (playingRecording === file.path) playRecording(null);
      await refresh();
    } catch (e) {
      reportFailure(e);
    }
  }

  return (
    <div className="panel recordings-panel">
      <div className="panel-title">Recordings</div>

      <div className="recordings-toolbar">
        <input
          className="recordings-search"
          type="text"
          placeholder="Filter by host"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
        <button className="btn-secondary btn-sm" onClick={() => setPicking(true)}>Open file…</button>
        <button
          className="btn-secondary btn-sm"
          disabled={!dir}
          onClick={() => { if (dir) ipc.sftpOpenLocal(dir).catch(reportFailure); }}
          title={hint(dir ?? '')}
        >
          Open folder
        </button>
        <button className="btn-secondary btn-sm" onClick={() => void refresh()}>Refresh</button>
      </div>

      <div className="recordings-body">
        <div className="recordings-list">
          {error ? (
            <p className="form-error">{error}</p>
          ) : files.length === 0 ? (
            <p className="list-empty">
              No recordings yet. Right-click a session tab and choose Record session to make one.
            </p>
          ) : shown.length === 0 ? (
            <p className="list-empty">No recordings match.</p>
          ) : shown.map((f) => {
            const { label, at } = recordingName(f.name);
            return (
              // A div, since a button cannot hold the two buttons in it.
              <div
                key={f.path}
                className={`recordings-row${playingRecording === f.path ? ' active' : ''}`}
                {...cardKeys(() => playRecording(f.path))}
                // Keys on the buttons inside are theirs, not the row's.
                onKeyDown={(e) => { if (e.target === e.currentTarget) cardKeys(() => playRecording(f.path)).onKeyDown(e); }}
                onClick={() => playRecording(f.path)}
                onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, file: f }); }}
                title={f.name}
              >
                <div className="recordings-row-text">
                  <span className="recordings-row-label">{label}</span>
                  <span className="recordings-row-detail">
                    {at ? when(at) : f.name}
                    {' · '}
                    {formatSize(f.size)}
                  </span>
                </div>
                <button
                  type="button"
                  className="recordings-row-btn"
                  onClick={(e) => { e.stopPropagation(); ipc.revealFile(f.path).catch(reportFailure); }}
                  title={hint('Show in folder')}
                  aria-label="Show in folder"
                >
                  <FolderIcon />
                </button>
                <button
                  type="button"
                  className="recordings-row-btn recordings-row-btn-danger"
                  onClick={(e) => { e.stopPropagation(); setConfirmDelete(f); }}
                  title={hint('Delete')}
                  aria-label="Delete"
                >
                  <TrashIcon />
                </button>
              </div>
            );
          })}
        </div>

        <div className="recordings-player">
          {playingRecording ? (
            <CastPlayer key={playingRecording} path={playingRecording} />
          ) : (
            <p className="list-empty">Choose a recording to play it here.</p>
          )}
        </div>
      </div>

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)}>
          <button className="menu-item" onClick={() => { playRecording(menu.file.path); setMenu(null); }}>Play</button>
          <button
            className="menu-item"
            onClick={() => { ipc.revealFile(menu.file.path).catch(reportFailure); setMenu(null); }}
          >
            Show in folder
          </button>
          <div className="menu-divider" />
          <button className="menu-item menu-item-danger" onClick={() => { setConfirmDelete(menu.file); setMenu(null); }}>
            Delete
          </button>
        </ContextMenu>
      )}

      {confirmDelete && (
        <ConfirmModal
          question={`Delete ${recordingName(confirmDelete.name).label}?`}
          hint={`${confirmDelete.name} is deleted from the recordings folder.`}
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => void remove(confirmDelete)}
        />
      )}

      {picking && (
        <FilePickerModal
          mode="open"
          title="Play a recording"
          startDir={dir ?? undefined}
          extensions={['.cast']}
          onCancel={() => setPicking(false)}
          onChoose={(path) => { setPicking(false); playRecording(path); }}
        />
      )}
    </div>
  );
}
