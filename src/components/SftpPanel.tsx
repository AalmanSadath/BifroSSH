import { useState, useEffect, useRef } from 'react';
import * as ipc from '../ipc';
import { listen } from '@tauri-apps/api/event';
import { useAppStore, buildJumpChain, resolveServerAuth } from '../store/appStore';
import OsIcon from './OsIcon';
import type { FileEntry, LogEntry, Server, TransferProgress, TransferSummary } from '../types';
import ConnectingView from './ConnectingView';
import ContextMenu from './shared/ContextMenu';
import { useDismissOnOutside } from './shared/useDismissOnOutside';

function formatSize(bytes: number, isDir: boolean): string {
  if (isDir) return '- -';
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${units[i]}`;
}

function formatDate(ts: number | null): string {
  if (!ts) return '- -';
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: 'numeric', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit',
  });
}

function pathSegments(path: string): { label: string; path: string }[] {
  if (!path) return [];
  const parts = path.split('/').filter(Boolean);
  return parts.map((part, i) => ({
    label: part,
    path: '/' + parts.slice(0, i + 1).join('/'),
  }));
}

function FolderIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <path
        d="M3 8a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V8z"
        fill="var(--accent)"
        opacity="0.9"
      />
    </svg>
  );
}

function FileIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ flexShrink: 0 }}>
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" strokeLinecap="round" strokeLinejoin="round" />
      <polyline points="14,2 14,8 20,8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const HEADERS = ['Name', 'Date Modified', 'Size', 'Type'] as const;
type SortCol = typeof HEADERS[number];
const DEFAULT_COL_WIDTHS = [44, 26, 12, 18];

interface FileBrowserProps {
  title: React.ReactNode;
  icon: React.ReactNode;
  path: string;
  entries: FileEntry[];
  loading: boolean;
  /** The directory could not be read, so there is no list to show. */
  error: string;
  /**
   * An operation failed while the listing is still good: a delete, a rename, a
   * transfer. Shown over the list rather than in place of it, because throwing
   * away the files you were looking at is not a way to report that one of them
   * would not delete.
   */
  notice?: string;
  onDismissNotice?: () => void;
  onNavigate: (path: string) => void;
  onRefresh?: () => void;
  onNewFolder?: (name: string) => void;
  extraActions?: React.ReactNode;
  onLocalBtn?: () => void;
  canCopyToTarget?: boolean;
  onCopyToTarget?: (entry: FileEntry) => void;
  onRename?: (entry: FileEntry, newName: string) => void;
  onDelete?: (entry: FileEntry) => void;
  side?: 'left' | 'right';
  isDropTarget?: boolean;
  transferring?: boolean;
  onDragEnter?: () => void;
  onDragLeave?: () => void;
  onFileDrop?: (entry: FileEntry, fromSide: 'left' | 'right') => void;
  onReconnect?: () => void;
}

function FileBrowser({ title, icon, path, entries, loading, error, notice, onDismissNotice, onNavigate,
  onRefresh, onNewFolder, extraActions, onLocalBtn,
  canCopyToTarget, onCopyToTarget, onRename, onDelete,
  side, isDropTarget, transferring, onDragEnter: onDragEnterCb, onDragLeave: onDragLeaveCb, onFileDrop, onReconnect
}: FileBrowserProps) {
  const { settings } = useAppStore();
  const hint = (t: string) => settings.show_hover_hints ? t : undefined;
  const segments = pathSegments(path);
  const [colWidths, setColWidths] = useState(DEFAULT_COL_WIDTHS);
  const [sortCol, setSortCol] = useState<SortCol>('Name');
  const [sortAsc, setSortAsc] = useState(true);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);
  const [dirsOnTop, setDirsOnTop] = useState(true);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: FileEntry | null } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<FileEntry | null>(null);
  const [newFolderName, setNewFolderName] = useState<string | null>(null);
  const [renamingEntry, setRenamingEntry] = useState<{ entry: FileEntry; value: string } | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const tableRef = useRef<HTMLTableElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const newFolderInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const dragCountRef = useRef(0);
  const lastClickIdxRef = useRef(-1);

  useEffect(() => {
    setSelectedPaths(new Set());
    lastClickIdxRef.current = -1;
  }, [path]);

  useEffect(() => {
    if (!onReconnect) setReconnecting(false);
  }, [onReconnect]);

  useDismissOnOutside(dropdownRef, dropdownOpen, () => setDropdownOpen(false));

  function handleNewFolderClick() {
    setDropdownOpen(false);
    setNewFolderName('');
    setTimeout(() => newFolderInputRef.current?.focus(), 30);
  }

  function commitNewFolder() {
    if (newFolderName?.trim()) onNewFolder?.(newFolderName.trim());
    setNewFolderName(null);
  }

  function handleRenameClick(entry: FileEntry) {
    setContextMenu(null);
    setRenamingEntry({ entry, value: entry.name });
    setTimeout(() => { renameInputRef.current?.focus(); renameInputRef.current?.select(); }, 30);
  }

  function commitRename() {
    if (renamingEntry && renamingEntry.value.trim() && renamingEntry.value.trim() !== renamingEntry.entry.name)
      onRename?.(renamingEntry.entry, renamingEntry.value.trim());
    setRenamingEntry(null);
  }

  function startResize(colIdx: number, e: React.MouseEvent<HTMLDivElement>) {
    e.preventDefault();
    const tableWidth = tableRef.current?.getBoundingClientRect().width ?? 800;
    const startX = e.clientX;
    const startW = colWidths[colIdx];
    const startNextW = colWidths[colIdx + 1] ?? 0;

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    function onMove(ev: MouseEvent) {
      const dPct = ((ev.clientX - startX) / tableWidth) * 100;
      setColWidths(prev => {
        const next = [...prev];
        next[colIdx] = Math.max(6, startW + dPct);
        if (colIdx + 1 < next.length) next[colIdx + 1] = Math.max(6, startNextW - dPct);
        return next;
      });
    }

    function onUp() {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }

  function handleRowClick(e: React.MouseEvent, entry: FileEntry, idx: number) {
    if (entry.name === '..') return;
    if (e.shiftKey && lastClickIdxRef.current >= 0) {
      const start = Math.min(lastClickIdxRef.current, idx);
      const end = Math.max(lastClickIdxRef.current, idx);
      const range = entries.slice(start, end + 1).filter(en => en.name !== '..');
      setSelectedPaths(prev => {
        const next = (e.ctrlKey || e.metaKey) ? new Set(prev) : new Set<string>();
        range.forEach(en => next.add(en.path));
        return next;
      });
    } else if (e.ctrlKey || e.metaKey) {
      setSelectedPaths(prev => {
        const next = new Set(prev);
        if (next.has(entry.path)) next.delete(entry.path);
        else next.add(entry.path);
        return next;
      });
      lastClickIdxRef.current = idx;
    } else {
      setSelectedPaths(new Set([entry.path]));
      lastClickIdxRef.current = idx;
    }
  }

  function handleDragStart(e: React.DragEvent, entry: FileEntry) {
    e.dataTransfer.setData('text/plain', JSON.stringify({ side, entry }));
    e.dataTransfer.effectAllowed = 'copy';
  }

  function handleDragOver(e: React.DragEvent) {
    if (!onFileDrop) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }

  function handleDragEnter(e: React.DragEvent) {
    if (!onFileDrop) return;
    e.preventDefault();
    dragCountRef.current++;
    if (dragCountRef.current === 1) onDragEnterCb?.();
  }

  function handleDragLeave() {
    if (!onFileDrop) return;
    dragCountRef.current--;
    if (dragCountRef.current === 0) setTimeout(() => { if (dragCountRef.current === 0) onDragLeaveCb?.(); }, 0);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCountRef.current = 0;
    onDragLeaveCb?.();
    if (!onFileDrop) return;
    const raw = e.dataTransfer.getData('text/plain');
    if (!raw) return;
    try {
      const { side: fromSide, entry } = JSON.parse(raw) as { side: 'left' | 'right'; entry: FileEntry };
      if (fromSide !== side) onFileDrop(entry, fromSide);
    } catch {}
  }

  return (
    <>
      <div className="sftp-panel-header">
        {onLocalBtn ? (
          <button className="sftp-local-header-btn" onClick={onLocalBtn} title={hint('Switch source')}>
            {icon}
            {title}
          </button>
        ) : (
          <div className="sftp-panel-title">
            {icon}
            {title}
          </div>
        )}
        <div className="sftp-panel-actions">
          {onReconnect && (
            reconnecting
              ? <span className="sftp-reconnecting-text">Reconnecting…</span>
              : <button className="sftp-reconnect-btn" onClick={() => { setReconnecting(true); onReconnect(); }}>Reconnect</button>
          )}
          <div className="sftp-dropdown-wrap" ref={dropdownRef}>
            <button className="sftp-action-btn" onClick={() => setDropdownOpen(o => !o)}>
              Actions ▾
            </button>
            {dropdownOpen && (
              <div className="sftp-dropdown-menu">
                <button className="menu-item" onClick={() => { setDropdownOpen(false); onRefresh?.(); }}>
                  Refresh
                </button>
                <button className="menu-item" onClick={handleNewFolderClick}>
                  New Folder
                </button>
                <button className="menu-item" onClick={() => { setDropdownOpen(false); setShowHidden(h => !h); }}>
                  {showHidden ? 'Hide Hidden Files' : 'Show Hidden Files'}
                </button>
                <label className="sftp-dropdown-checkbox" onClick={(e) => e.stopPropagation()}>
                  Folders on top
                  <input type="checkbox" checked={dirsOnTop} onChange={(e) => setDirsOnTop(e.target.checked)} />
                </label>
                {extraActions && <div className="menu-divider" />}
                {extraActions}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="sftp-breadcrumb">
        {segments.map((seg, i) => (
          <span key={seg.path} className="sftp-crumb-item">
            {i > 0 && <span className="sftp-crumb-sep">›</span>}
            <button className="sftp-crumb-btn" onClick={() => onNavigate(seg.path)}>
              <FolderIcon size={13} />
              {seg.label}
            </button>
          </span>
        ))}
      </div>

      <div
        className="sftp-table-wrap"
        onDragOver={handleDragOver}
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, entry: null }); }}
      >
        <table className="sftp-table" ref={tableRef}>
          <colgroup>
            {colWidths.map((w, i) => <col key={i} style={{ width: `${w}%` }} />)}
          </colgroup>
          <thead>
            <tr>
              {HEADERS.map((h, i) => (
                <th key={h} onClick={() => { if (sortCol === h) setSortAsc(v => !v); else { setSortCol(h); setSortAsc(true); } }} style={{ cursor: 'pointer' }}>
                  <span className="sftp-th-label">
                    {h}
                    {sortCol === h && <span className="sftp-sort-arrow">{sortAsc ? '▲' : '▼'}</span>}
                  </span>
                  {i < HEADERS.length - 1 && (
                    <div className="sftp-col-handle" onMouseDown={(e) => { e.stopPropagation(); startResize(i, e); }} />
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {newFolderName !== null && (
              <tr className="sftp-row">
                <td colSpan={4}>
                  <div className="sftp-name-cell">
                    <FolderIcon />
                    <input
                      ref={newFolderInputRef}
                      className="sftp-inline-input"
                      value={newFolderName}
                      onChange={(e) => setNewFolderName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') commitNewFolder(); if (e.key === 'Escape') setNewFolderName(null); }}
                      onBlur={commitNewFolder}
                      placeholder="Folder name"
                    />
                  </div>
                </td>
              </tr>
            )}
            {loading ? (
              <tr><td colSpan={4} className="sftp-status-cell">Loading…</td></tr>
            ) : error ? (
              <tr><td colSpan={4} className="sftp-status-cell sftp-cell-error">{error}</td></tr>
            ) : (() => {
              const dotdot = entries.filter(en => en.name === '..');
              const rest = entries
                .filter(en => en.name !== '..' && (showHidden || !en.name.startsWith('.')))
                .sort((a, b) => {
                  if (dirsOnTop && a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
                  let cmp = 0;
                  if (sortCol === 'Name') cmp = a.name.localeCompare(b.name);
                  else if (sortCol === 'Date Modified') cmp = (a.modified ?? 0) - (b.modified ?? 0);
                  else if (sortCol === 'Size') cmp = a.size - b.size;
                  else if (sortCol === 'Type') cmp = a.kind.localeCompare(b.kind);
                  return sortAsc ? cmp : -cmp;
                });
              return [...dotdot, ...rest];
            })().map((entry, idx) => (
              <tr
                key={entry.path}
                className={`sftp-row${selectedPaths.has(entry.path) ? ' sftp-row-selected' : ''}`}
                draggable={entry.name !== '..'}
                onClick={(e) => handleRowClick(e, entry, idx)}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setContextMenu({ x: e.clientX, y: e.clientY, entry }); }}
                onDragStart={(e) => entry.name !== '..' && handleDragStart(e, entry)}
                onDoubleClick={() => entry.is_dir && onNavigate(entry.path)}
                title={entry.is_dir ? hint('Double-click to open') : entry.name}
              >
                <td>
                  <div className="sftp-name-cell">
                    {entry.is_dir ? <FolderIcon /> : <FileIcon />}
                    {renamingEntry?.entry.path === entry.path ? (
                      <input
                        ref={renameInputRef}
                        className="sftp-inline-input"
                        value={renamingEntry.value}
                        onChange={(e) => setRenamingEntry({ ...renamingEntry, value: e.target.value })}
                        onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenamingEntry(null); }}
                        onBlur={commitRename}
                        onClick={(e) => e.stopPropagation()}
                      />
                    ) : (
                      <span className="sftp-name-text">{entry.name}</span>
                    )}
                    {!renamingEntry && entry.permissions && (
                      <span className="sftp-perms">{entry.permissions}</span>
                    )}
                  </div>
                </td>
                <td>{formatDate(entry.modified)}</td>
                <td>{formatSize(entry.size, entry.is_dir)}</td>
                <td>{entry.kind}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {isDropTarget && (
          <div className="sftp-drop-overlay"><span>Drop to copy here</span></div>
        )}
        {transferring && (
          <div className="sftp-transfer-overlay">
            <span>Transferring…</span>
          </div>
        )}
      </div>

      {contextMenu && (
        <ContextMenu
          className="sftp-context-menu"
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
        >
          {contextMenu.entry ? (
            <>
              {canCopyToTarget && (
                <button className="menu-item" onClick={() => { onCopyToTarget?.(contextMenu.entry!); setContextMenu(null); }}>
                  Copy to Target
                </button>
              )}
              <button className="menu-item" onClick={() => handleRenameClick(contextMenu.entry!)}>
                Rename
              </button>
              <div className="menu-divider" />
              <button className="menu-item menu-item-danger" onClick={() => { setConfirmDelete(contextMenu.entry); setContextMenu(null); }}>
                Delete
              </button>
            </>
          ) : (
            <>
              <button className="menu-item" onClick={() => { onRefresh?.(); setContextMenu(null); }}>
                Refresh
              </button>
              <button className="menu-item" onClick={() => { setContextMenu(null); handleNewFolderClick(); }}>
                New Folder
              </button>
              <button className="menu-item" onClick={() => { setShowHidden(h => !h); setContextMenu(null); }}>
                {showHidden ? 'Hide Hidden Files' : 'Show Hidden Files'}
              </button>
              <button className="menu-item" onClick={() => { setDirsOnTop(v => !v); setContextMenu(null); }}>
                {dirsOnTop ? 'Folders on Top ✓' : 'Folders on Top'}
              </button>
            </>
          )}
        </ContextMenu>
      )}

      {notice && (
        <div className="sftp-notice">
          <span className="sftp-notice-text">{notice}</span>
          <button
            className="sftp-notice-close"
            onClick={onDismissNotice}
            aria-label="Dismiss"
            title="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      {confirmDelete && (
        <div className="sftp-confirm-overlay">
          <div className="sftp-confirm-dialog">
            <p className="sftp-confirm-title">Delete "{confirmDelete.name}"?</p>
            <p className="sftp-confirm-sub">This cannot be undone.</p>
            <div className="sftp-confirm-actions">
              <button className="sftp-action-btn" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="sftp-confirm-delete-btn" onClick={() => { onDelete?.(confirmDelete); setConfirmDelete(null); }}>Delete</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function ConnectPrompt({ onSelectHost, onGoLocal }: { onSelectHost: () => void; onGoLocal?: () => void }) {
  const { settings } = useAppStore();
  const hint = (t: string) => settings.show_hover_hints ? t : undefined;
  return (
    <div className="sftp-connect-prompt" onContextMenu={(e) => e.preventDefault()}>
      <div className="sftp-source-list">
        {onGoLocal && (
          <button className="sftp-source-item" onDoubleClick={onGoLocal} onClick={onGoLocal} title={hint('Open local filesystem')}>
            <div className="sftp-source-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                <polyline points="9,22 9,12 15,12 15,22" />
              </svg>
            </div>
            <div className="sftp-source-info">
              <div className="sftp-source-name">Local Files</div>
              <div className="sftp-source-sub">Browse this computer</div>
            </div>
          </button>
        )}
        <div className="sftp-source-sep" />
        <button className="sftp-source-item sftp-source-remote" onClick={onSelectHost}>
          <div className="sftp-source-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
          </div>
          <div className="sftp-source-info">
            <div className="sftp-source-name">Remote Host</div>
            <div className="sftp-source-sub">Connect via SFTP</div>
          </div>
        </button>
      </div>
    </div>
  );
}

interface HostPickerProps {
  servers: Server[];
  connectingId: string | null;
  activeServerId?: string | null;
  error: string;
  onConnect: (server: Server) => void;
  onBack: () => void;
  onGoLocal?: () => void;
}

function HostPicker({ servers, connectingId, activeServerId, error, onConnect, onBack, onGoLocal }: HostPickerProps) {
  const { settings, identities } = useAppStore();
  const hint = (t: string) => settings.show_hover_hints ? t : undefined;
  return (
    <div className="sftp-host-picker" onContextMenu={(e) => e.preventDefault()}>
      <div className="sftp-picker-header">
        <button className="sftp-back-btn" onClick={onBack} title={hint('Back')}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15,18 9,12 15,6" />
          </svg>
        </button>
        <span className="sftp-picker-title">Select Host</span>
        {onGoLocal && (
          <button className="sftp-local-header-btn" onClick={onGoLocal}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
              <polyline points="9,22 9,12 15,12 15,22" />
            </svg>
            Local
          </button>
        )}
      </div>
      {error && <div className="sftp-picker-error">{error}</div>}
      <div className="sftp-picker-list">
        {servers.length === 0 ? (
          <div className="sftp-picker-empty">No hosts configured. Add one in Hosts.</div>
        ) : servers.map((s) => (
          <div
            key={s.id}
            className={`sftp-picker-item${connectingId === s.id ? ' sftp-picker-connecting' : ''}${activeServerId === s.id ? ' sftp-picker-has-session' : ''}`}
            onDoubleClick={() => !connectingId && onConnect(s)}
            title={hint(activeServerId === s.id ? 'Double-click to resume' : 'Double-click to connect via SFTP')}
          >
            <div className="sftp-picker-icon">
              <OsIcon os={s.os} size={28} />
            </div>
            <div className="sftp-picker-info">
              <div className="sftp-picker-name">{s.name}</div>
              <div className="sftp-picker-addr">{(s.username ?? identities.find(i => i.id === s.identity_id)?.username ?? 'ssh')} · {s.host}:{s.port}</div>
            </div>
            {activeServerId === s.id && !connectingId && (
              <span className="sftp-active-badge">● Active</span>
            )}
            {connectingId === s.id && (
              <span className="sftp-picker-status">Connecting…</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** What a pane is showing. Both panes use all five. */
type PaneMode = 'local' | 'idle' | 'picking' | 'connecting' | 'connected';

/** One directory, as shown. The four move together, so they are stored together. */
interface Listing {
  path: string;
  entries: FileEntry[];
  loading: boolean;
  error: string;
}

const emptyListing = (loading: boolean): Listing => ({ path: '', entries: [], loading, error: '' });

/**
 * One side of the panel.
 *
 * The two panes are the same machine: either can browse the local disk or
 * connect to a host, and each has its own local listing, remote listing,
 * session and connect progress. That was written out twice, under `local`/
 * `left` prefixes on one side and `rightLocal`/`remote`/`connect` on the
 * other, which is why there were two connect functions, two disconnects, four
 * navigate functions and twelve CRUD handlers for six operations.
 *
 * They differ in two things only, both arguments here: where they start, and
 * that the left pane loads the local home at mount while the right waits until
 * asked.
 */
function usePane(initialMode: PaneMode) {
  const { servers, identities } = useAppStore();

  const [mode, setMode] = useState<PaneMode>(initialMode);
  const [local, setLocal] = useState<Listing>(emptyListing(initialMode === 'local'));
  const [remote, setRemote] = useState<Listing>(emptyListing(false));

  const [sid, setSid] = useState<string | null>(null);
  // Outlives `sid`: a dropped connection clears the session but keeps the
  // host, so the reconnect button knows what to reconnect to.
  const [serverId, setServerId] = useState<string | null>(null);
  const [serverName, setServerName] = useState('');
  const [disconnected, setDisconnected] = useState(false);

  // Separate from the listings: an operation that fails leaves the directory
  // it was working in perfectly readable, so its message must not take the
  // place of one.
  const [notice, setNotice] = useState('');

  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState('');
  const [connectLogs, setConnectLogs] = useState<LogEntry[]>([]);
  const [connectServer, setConnectServer] = useState<Server | null>(null);

  /** The listing the pane is currently showing, whichever side it is on. */
  const listing = mode === 'local' ? local : remote;

  async function navigateLocal(path: string) {
    if (path !== local.path) setNotice('');
    setLocal((l) => ({ ...l, path, loading: true, error: '' }));
    try {
      const entries = await ipc.sftpListLocal(path);
      setLocal((l) => ({ ...l, entries, loading: false }));
    } catch (e) {
      setLocal((l) => ({ ...l, error: String(e), loading: false }));
    }
  }

  async function navigateRemote(path: string) {
    if (!sid) return;
    if (path !== remote.path) setNotice('');
    setRemote((r) => ({ ...r, path, loading: true, error: '' }));
    try {
      const entries = await ipc.sftpListRemote(sid, path);
      setRemote((r) => ({ ...r, entries, loading: false }));
    } catch (e) {
      // A failed listing on a live session means the session is gone. Dropping
      // the id is what puts the reconnect button up.
      setRemote((r) => ({ ...r, error: String(e), loading: false }));
      setDisconnected(true);
      setSid(null);
    }
  }

  /** Re-lists whichever side is showing, after a change made to it. */
  const refresh = () => (mode === 'local' ? navigateLocal(local.path) : navigateRemote(remote.path));

  /** Shows the local disk, fetching the home directory the first time only. */
  async function goLocal() {
    setMode('local');
    if (!local.path) {
      const home = await ipc.sftpLocalHome().catch(() => '/');
      await navigateLocal(home);
    }
  }

  async function connect(server: Server) {
    // Resume the session already open for this host rather than making another.
    if (server.id === serverId && sid) {
      setMode('connected');
      return;
    }

    const resolved = await resolveServerAuth(server, identities);
    if (!resolved) {
      setConnectError(`No authentication configured for "${server.name}". Add a key, password or prompt auth in Hosts settings.`);
      return;
    }
    const { username, authType, authValue } = resolved;

    setConnectingId(server.id);
    setConnectError('');
    setConnectLogs([]);
    setConnectServer(server);
    setMode('connecting');

    // Narrate the connect the same way a terminal session does, so a stall or
    // rejection is visible instead of leaving a bare spinner.
    const connectId = crypto.randomUUID();
    const unlisten = await listen<LogEntry>(`ssh-connect-log:${connectId}`, (event) => {
      setConnectLogs((prev) => [...prev, event.payload]);
    });

    try {
      const newSid = await ipc.sftpConnectRemote(
        server.id,
        username,
        authType,
        authValue,
        connectId,
        await buildJumpChain(server, servers, identities),
      );
      setSid(newSid);
      setServerId(server.id);
      setServerName(server.name);
      setMode('connected');
      setDisconnected(false);
      setRemote((r) => ({ ...r, error: '', loading: true }));

      const home = await ipc.sftpGetHome(newSid);
      const entries = await ipc.sftpListRemote(newSid, home);
      setRemote({ path: home, entries, loading: false, error: '' });
    } catch (e) {
      // Stay on the connecting screen so the log explaining the failure, and
      // the retry button, are both still there.
      setConnectError(String(e));
    } finally {
      // Trailing log lines race the invoke response over the same bridge.
      setTimeout(unlisten, 1000);
      setConnectingId(null);
      setRemote((r) => ({ ...r, loading: false }));
    }
  }

  async function disconnect() {
    if (sid) {
      await ipc.sftpDisconnectRemote(sid).catch(() => {});
    }
    setMode('idle');
    setSid(null);
    setServerId(null);
    setServerName('');
    setDisconnected(false);
    setRemote(emptyListing(false));
  }

  /** Reconnects to the host whose session dropped, if there is one. */
  const reconnect = disconnected
    ? () => {
        const s = servers.find((sv) => sv.id === serverId);
        if (s) connect(s);
      }
    : undefined;

  // The six operations below were twelve handlers: one pair per operation,
  // differing only in which prefix they set and which navigate they called.

  /**
   * The remote session, insisted on rather than assumed.
   *
   * `sid` is null between a dropped connection and a reconnect, and every
   * remote command took it as-is: the null went across the bridge and came
   * back as a deserialize error naming a Rust type. The pane shows its
   * reconnect view in that state so none of these should be reachable, but
   * saying so out loud costs one line and turns an internal error into the
   * sentence the user needs.
   */
  function requireSid(): string {
    if (!sid) throw new Error('The connection to this server was lost');
    return sid;
  }

  async function newFolder(name: string) {
    const path = listing.path.replace(/\/$/, '') + '/' + name;
    try {
      if (mode === 'local') await ipc.sftpCreateLocalDir(path);
      else await ipc.sftpMkdir(requireSid(), path);
    } catch (e) {
      fail(String(e));
    } finally {
      await refresh();
    }
  }

  async function rename(entry: FileEntry, newName: string) {
    const parent = entry.path.substring(0, entry.path.lastIndexOf('/'));
    try {
      if (mode === 'local') {
        await ipc.sftpRenameLocal(entry.path, parent + '/' + newName);
      } else {
        // A file directly under the remote root would otherwise become "//name".
        const base = parent || '/';
        await ipc.sftpRenameRemote(requireSid(), entry.path, (base === '/' ? '' : base) + '/' + newName);
      }
    } catch (e) {
      fail(String(e));
    } finally {
      await refresh();
    }
  }

  async function remove(entry: FileEntry) {
    try {
      if (mode === 'local') await ipc.sftpDeleteLocal(entry.path);
      else await ipc.sftpDeleteRemote(requireSid(), entry.path, entry.is_dir);
    } catch (e) {
      fail(String(e));
    } finally {
      await refresh();
    }
  }

  /** Reports a failed operation without disturbing the list behind it. */
  function fail(message: string) {
    setNotice(message);
  }

  /** Same place, for something that went well enough but is worth saying. */
  function say(message: string) {
    setNotice(message);
  }

  return {
    mode, setMode, listing, local, remote, notice, dismissNotice: () => setNotice(''),
    sid, serverId, serverName, disconnected,
    connectingId, connectError, setConnectError, connectServer, connectLogs,
    navigate: (path: string) => (mode === 'local' ? navigateLocal(path) : navigateRemote(path)),
    refresh, goLocal, connect, disconnect, reconnect,
    newFolder, rename, remove, fail, say, requireSid,
  };
}

type Pane = ReturnType<typeof usePane>;

/** Whether dragging from `src` onto `dst` is a transfer this app can make. */
function canMove(src: Pane, dst: Pane): boolean {
  const browsing = (p: Pane) => p.mode === 'local' || p.mode === 'connected';
  // Local to local is the one pairing with no command behind it.
  return browsing(src) && browsing(dst) && !(src.mode === 'local' && dst.mode === 'local');
}

const LOCAL_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
    <polyline points="9,22 9,12 15,12 15,22" />
  </svg>
);

const REMOTE_ICON = (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
    <line x1="8" y1="21" x2="16" y2="21" />
    <line x1="12" y1="17" x2="12" y2="21" />
  </svg>
);

const closeConnectionActions = (onClose: () => void) => (
  <>
    <div className="menu-divider" />
    <button className="menu-item menu-item-danger" onClick={onClose}>
      Close Connection
    </button>
  </>
);

export default function SftpPanel() {
  const { servers } = useAppStore();

  // The left pane starts on the local disk, the right on the host list. That
  // and the eager home fetch below are the only asymmetry between them.
  const left = usePane('local');
  const right = usePane('picking');

  const [dropTarget, setDropTarget] = useState<'left' | 'right' | null>(null);
  const [transferring, setTransferring] = useState(false);
  const [transferTarget, setTransferTarget] = useState<'left' | 'right' | null>(null);
  const [progress, setProgress] = useState<(TransferProgress & { startTime: number }) | null>(null);
  // The transfer stops at the next chunk boundary, not on the click, so the
  // button says so rather than looking like it did nothing.
  const [cancelling, setCancelling] = useState(false);

  useEffect(() => {
    const unlisten = listen<TransferProgress>('sftp-progress', (e) => {
      setProgress((prev) => ({
        ...e.payload,
        startTime: prev?.startTime ?? Date.now(),
      }));
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  useEffect(() => { left.goLocal(); }, []);

  /**
   * What a finished transfer is worth saying, or nothing.
   *
   * The backend has always counted these and the panel has always thrown the
   * answer away, so a batch that quietly copied less than was asked for looked
   * identical to one that copied all of it. Only the two surprises are
   * reported: a transfer that did what was asked needs no announcement.
   */
  function describeTransfer(s: TransferSummary): string | null {
    const parts: string[] = [];
    if (s.cancelled) {
      parts.push(`Stopped after ${s.files} ${s.files === 1 ? 'file' : 'files'}.`);
    }
    if (s.skipped_symlinks > 0) {
      const n = s.skipped_symlinks;
      parts.push(`${n} ${n === 1 ? 'symlink was' : 'symlinks were'} not copied.`);
    }
    return parts.length > 0 ? parts.join(' ') : null;
  }

  /**
   * Moves `entry` into the pane named by `target`, from the other one.
   *
   * Which of the three commands runs falls out of what the two panes are
   * showing: local to remote uploads, remote to local downloads, remote to
   * remote copies. Refreshing is deliberately not part of the transfer: it has
   * to happen whether the transfer finished, failed part way, or was
   * cancelled, and in the last two cases there is still something new on the
   * destination to show.
   */
  async function handleDrop(target: 'left' | 'right', entry: FileEntry) {
    const dst = target === 'left' ? left : right;
    const src = target === 'left' ? right : left;
    if (!canMove(src, dst)) return;

    const run = (): Promise<TransferSummary> => {
      if (src.mode === 'local') {
        return ipc.sftpUpload(dst.requireSid(), entry.path, dst.listing.path);
      }
      if (dst.mode === 'local') {
        return ipc.sftpDownload(src.requireSid(), entry.path, dst.listing.path);
      }
      return ipc.sftpCopyRemoteToRemote(src.requireSid(), entry.path, dst.requireSid(), dst.listing.path);
    };

    setTransferring(true);
    setTransferTarget(target);
    setDropTarget(null);
    try {
      const summary = await run();
      const said = describeTransfer(summary);
      if (said) dst.say(said);
    } catch (e) {
      // Was only logged to the console before, so a transfer that failed
      // looked exactly like one that did nothing.
      dst.fail(String(e));
    } finally {
      setTransferring(false);
      setTransferTarget(null);
      setProgress(null);
      setCancelling(false);
      await dst.refresh();
    }
  }

  /** One pane, in whichever of its five modes it is in. */
  function renderPane(pane: Pane, other: Pane, side: 'left' | 'right') {
    const browser = (
      <FileBrowser
        title={pane.mode === 'local' ? 'Local' : pane.serverName}
        icon={pane.mode === 'local' ? LOCAL_ICON : REMOTE_ICON}
        path={pane.listing.path}
        entries={pane.listing.entries}
        loading={pane.listing.loading}
        error={pane.listing.error}
        notice={pane.notice}
        onDismissNotice={pane.dismissNotice}
        onNavigate={pane.navigate}
        onRefresh={pane.refresh}
        onNewFolder={pane.newFolder}
        canCopyToTarget={canMove(pane, other)}
        onCopyToTarget={(entry) => handleDrop(side === 'left' ? 'right' : 'left', entry)}
        onRename={pane.rename}
        onDelete={pane.remove}
        onLocalBtn={() => pane.setMode('idle')}
        extraActions={closeConnectionActions(
          pane.mode === 'local' ? () => pane.setMode('idle') : pane.disconnect,
        )}
        side={side}
        isDropTarget={dropTarget === side && !transferring}
        transferring={transferring && transferTarget === side}
        onDragEnter={() => setDropTarget(side)}
        onDragLeave={() => setDropTarget((p) => (p === side ? null : p))}
        onFileDrop={(entry) => handleDrop(side, entry)}
        onReconnect={pane.mode === 'connected' ? pane.reconnect : undefined}
      />
    );

    switch (pane.mode) {
      case 'local':
      case 'connected':
        return browser;
      case 'idle':
        return (
          <ConnectPrompt
            onSelectHost={() => pane.setMode('picking')}
            onGoLocal={pane.goLocal}
          />
        );
      case 'connecting':
        return pane.connectServer && (
          <ConnectingView
            server={pane.connectServer}
            logs={pane.connectLogs}
            error={pane.connectError || undefined}
            onClose={() => { pane.setMode('picking'); pane.setConnectError(''); }}
            onRetry={() => pane.connect(pane.connectServer!)}
            retryLabel="Retry"
          />
        );
      case 'picking':
        return (
          <HostPicker
            servers={servers}
            connectingId={pane.connectingId}
            activeServerId={pane.serverId}
            error={pane.connectError}
            onConnect={pane.connect}
            onBack={() => { pane.setMode('idle'); pane.setConnectError(''); }}
            onGoLocal={pane.goLocal}
          />
        );
    }
  }

  return (
    <div className="sftp-container">
      <div className="sftp-panels-row">
        <div className="sftp-file-panel">{renderPane(left, right, 'left')}</div>
        <div className="sftp-divider" />
        <div className="sftp-file-panel sftp-remote-panel">{renderPane(right, left, 'right')}</div>
      </div>
      {progress && (() => {
        const pct = progress.total > 0 ? Math.min(100, Math.round((progress.transferred / progress.total) * 100)) : 0;
        const elapsed = (Date.now() - progress.startTime) / 1000;
        const speed = elapsed > 0.1 ? progress.transferred / elapsed : 0;
        const remaining = speed > 0 ? (progress.total - progress.transferred) / speed : null;
        const eta = remaining !== null
          ? remaining < 60 ? `${Math.ceil(remaining)}s` : `${Math.ceil(remaining / 60)}m`
          : '…';
        const speedStr = speed > 0
          ? speed >= 1024 * 1024
            ? `${(speed / (1024 * 1024)).toFixed(1)} MB/s`
            : speed >= 1024
              ? `${(speed / 1024).toFixed(1)} KB/s`
              : `${Math.round(speed)} B/s`
          : '';
        return (
          <div className="sftp-progress-wrap">
            <div className="sftp-progress-info">
              <span className="sftp-progress-name">
                {progress.file_count > 1 && (
                  <span className="sftp-progress-count">
                    {progress.file_index}/{progress.file_count}
                  </span>
                )}
                {progress.file_name}
              </span>
              <span className="sftp-progress-stat">{pct}% · {speedStr}{speedStr ? ' · ' : ''}ETA {eta}</span>
              <button
                type="button"
                className="sftp-cancel-btn"
                onClick={() => { setCancelling(true); ipc.sftpCancelTransfer().catch(() => {}); }}
                disabled={cancelling}
              >
                {cancelling ? 'Stopping…' : 'Cancel'}
              </button>
            </div>
            <div className="sftp-progress-track">
              <div className="sftp-progress-fill" style={{ width: `${pct}%` }} />
            </div>
          </div>
        );
      })()}
    </div>
  );
}
