import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useAppStore } from '../store/appStore';
import OsIcon from './OsIcon';
import type { Server } from '../types';

interface TransferProgress {
  file_name: string;
  transferred: number;
  total: number;
}

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number | null;
  permissions: string;
  kind: string;
}

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
  error: string;
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

function FileBrowser({ title, icon, path, entries, loading, error, onNavigate,
  onRefresh, onNewFolder, extraActions, onLocalBtn,
  canCopyToTarget, onCopyToTarget, onRename, onDelete,
  side, transferring, onDragEnter: onDragEnterCb, onDragLeave: onDragLeaveCb, onFileDrop, onReconnect
}: FileBrowserProps) {
  const { settings } = useAppStore();
  const hint = (t: string) => settings.show_hover_hints ? t : undefined;
  const segments = pathSegments(path);
  const [colWidths, setColWidths] = useState(DEFAULT_COL_WIDTHS);
  const [sortCol, setSortCol] = useState<SortCol>('Name');
  const [sortAsc, setSortAsc] = useState(true);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: FileEntry } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<FileEntry | null>(null);
  const [newFolderName, setNewFolderName] = useState<string | null>(null);
  const [renamingEntry, setRenamingEntry] = useState<{ entry: FileEntry; value: string } | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const tableRef = useRef<HTMLTableElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    if (!dropdownOpen) return;
    function onClickOutside(e: MouseEvent) {
      if (!dropdownRef.current?.contains(e.target as Node)) setDropdownOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [dropdownOpen]);

  useEffect(() => {
    if (!contextMenu) return;
    function onClickOutside(e: MouseEvent) {
      if (!contextMenuRef.current?.contains(e.target as Node)) setContextMenu(null);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [contextMenu]);

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
                <button className="sftp-dropdown-item" onClick={() => { setDropdownOpen(false); onRefresh?.(); }}>
                  Refresh
                </button>
                <button className="sftp-dropdown-item" onClick={handleNewFolderClick}>
                  New Folder
                </button>
                <button className="sftp-dropdown-item" onClick={() => { setDropdownOpen(false); setShowHidden(h => !h); }}>
                  {showHidden ? 'Hide Hidden Files' : 'Show Hidden Files'}
                </button>
                {extraActions && <div className="sftp-dropdown-divider" />}
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
                    {sortCol === h && <span className="sftp-sort-arrow">{sortAsc ? ' ▲' : ' ▼'}</span>}
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
                draggable={!entry.is_dir && entry.name !== '..'}
                onClick={(e) => handleRowClick(e, entry, idx)}
                onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, entry }); }}
                onDragStart={(e) => !entry.is_dir && entry.name !== '..' && handleDragStart(e, entry)}
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
        {transferring && (
          <div className="sftp-transfer-overlay">
            <span>Transferring…</span>
          </div>
        )}
      </div>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="sftp-context-menu"
          style={{
            top: Math.min(contextMenu.y, window.innerHeight - 130),
            left: Math.min(contextMenu.x, window.innerWidth - 190),
          }}
        >
          {!contextMenu.entry.is_dir && canCopyToTarget && (
            <button className="sftp-ctx-item" onClick={() => { onCopyToTarget?.(contextMenu.entry); setContextMenu(null); }}>
              Copy to Target
            </button>
          )}
          <button className="sftp-ctx-item" onClick={() => handleRenameClick(contextMenu.entry)}>
            Rename
          </button>
          <div className="sftp-ctx-divider" />
          <button className="sftp-ctx-item sftp-ctx-danger" onClick={() => { setConfirmDelete(contextMenu.entry); setContextMenu(null); }}>
            Delete
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
    <div className="sftp-connect-prompt">
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
  const { settings } = useAppStore();
  const hint = (t: string) => settings.show_hover_hints ? t : undefined;
  return (
    <div className="sftp-host-picker">
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
              <OsIcon os={s.os ?? 'linux'} size={28} />
            </div>
            <div className="sftp-picker-info">
              <div className="sftp-picker-name">{s.name}</div>
              <div className="sftp-picker-addr">ssh · {s.host}:{s.port}</div>
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

export default function SftpPanel() {
  const { servers, identities } = useAppStore();

  // Local filesystem
  const [localPath, setLocalPath] = useState('');
  const [localEntries, setLocalEntries] = useState<FileEntry[]>([]);
  const [localLoading, setLocalLoading] = useState(true);
  const [localError, setLocalError] = useState('');

  // Left panel (local by default, can connect to remote)
  type LeftState = 'local' | 'idle' | 'picking' | 'connected';
  const [leftState, setLeftState] = useState<LeftState>('local');
  const [leftPath, setLeftPath] = useState('');
  const [leftEntries, setLeftEntries] = useState<FileEntry[]>([]);
  const [leftLoading, setLeftLoading] = useState(false);
  const [leftError, setLeftError] = useState('');
  const [leftSid, setLeftSid] = useState<string | null>(null);
  const [leftServerId, setLeftServerId] = useState<string | null>(null);
  const [leftServerName, setLeftServerName] = useState('');
  const [leftConnectingId, setLeftConnectingId] = useState<string | null>(null);
  const [leftConnectError, setLeftConnectError] = useState('');

  // Right local filesystem (when right panel shows local)
  const [rightLocalPath, setRightLocalPath] = useState('');
  const [rightLocalEntries, setRightLocalEntries] = useState<FileEntry[]>([]);
  const [rightLocalLoading, setRightLocalLoading] = useState(false);
  const [rightLocalError, setRightLocalError] = useState('');

  // Right panel (idle | local | picking | connected)
  type RemoteState = 'idle' | 'local' | 'picking' | 'connected';
  const [remoteState, setRemoteState] = useState<RemoteState>('picking');
  const [remotePath, setRemotePath] = useState('');
  const [remoteEntries, setRemoteEntries] = useState<FileEntry[]>([]);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [remoteError, setRemoteError] = useState('');
  const [remoteSid, setRemoteSid] = useState<string | null>(null);
  const [remoteServerId, setRemoteServerId] = useState<string | null>(null);
  const [remoteServerName, setRemoteServerName] = useState('');
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState('');

  // Unexpected disconnect flags (set when navigate/list fails while connected)
  const [leftDisconnected, setLeftDisconnected] = useState(false);
  const [remoteDisconnected, setRemoteDisconnected] = useState(false);

  // Drag-and-drop transfer state
  const [dropTarget, setDropTarget] = useState<'left' | 'right' | null>(null);
  const [transferring, setTransferring] = useState(false);
  const [transferTarget, setTransferTarget] = useState<'left' | 'right' | null>(null);
  const [progress, setProgress] = useState<(TransferProgress & { startTime: number }) | null>(null);

  useEffect(() => {
    const unlisten = listen<TransferProgress>('sftp-progress', (e) => {
      setProgress((prev) => ({
        ...e.payload,
        startTime: prev?.startTime ?? Date.now(),
      }));
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  useEffect(() => {
    invoke<string>('sftp_local_home').then((home) => navigateLocal(home)).catch((e) => {
      setLocalError(String(e));
      setLocalLoading(false);
    });
  }, []);

  async function navigateLocal(path: string) {
    setLocalLoading(true);
    setLocalError('');
    setLocalPath(path);
    try {
      const entries = await invoke<FileEntry[]>('sftp_list_local', { path });
      setLocalEntries(entries);
    } catch (e) {
      setLocalError(String(e));
    } finally {
      setLocalLoading(false);
    }
  }

  async function navigateRightLocal(path: string) {
    setRightLocalLoading(true);
    setRightLocalError('');
    setRightLocalPath(path);
    try {
      const entries = await invoke<FileEntry[]>('sftp_list_local', { path });
      setRightLocalEntries(entries);
    } catch (e) {
      setRightLocalError(String(e));
    } finally {
      setRightLocalLoading(false);
    }
  }

  async function navigateRemote(path: string) {
    if (!remoteSid) return;
    setRemoteLoading(true);
    setRemoteError('');
    setRemotePath(path);
    try {
      const entries = await invoke<FileEntry[]>('sftp_list_remote', { sessionId: remoteSid, path });
      setRemoteEntries(entries);
    } catch (e) {
      setRemoteError(String(e));
      setRemoteDisconnected(true);
      setRemoteSid(null);
    } finally {
      setRemoteLoading(false);
    }
  }

  async function navigateLeftRemote(path: string) {
    if (!leftSid) return;
    setLeftLoading(true);
    setLeftError('');
    setLeftPath(path);
    try {
      const entries = await invoke<FileEntry[]>('sftp_list_remote', { sessionId: leftSid, path });
      setLeftEntries(entries);
    } catch (e) {
      setLeftError(String(e));
      setLeftDisconnected(true);
      setLeftSid(null);
    } finally {
      setLeftLoading(false);
    }
  }

  async function openRightLocal() {
    setRemoteState('local');
    if (!rightLocalPath) {
      const home = await invoke<string>('sftp_local_home').catch(() => '/');
      await navigateRightLocal(home);
    }
  }

  async function handleLeftSftpConnect(server: Server) {
    // Resume existing session for this host
    if (server.id === leftServerId && leftSid) {
      setLeftState('connected');
      return;
    }
    const identity = identities.find((i) => i.id === server.identity_id);
    if (!identity) {
      setLeftConnectError(`No identity configured for "${server.name}". Add one in Hosts settings.`);
      return;
    }
    setLeftConnectingId(server.id);
    setLeftConnectError('');
    try {
      const sid = await invoke<string>('sftp_connect_remote', {
        serverId: server.id,
        username: identity.username,
        authType: 'key',
        authValue: identity.key_id,
      });
      setLeftSid(sid);
      setLeftServerId(server.id);
      setLeftServerName(server.name);
      setLeftState('connected');
      setLeftDisconnected(false);
      setLeftError('');
      setLeftLoading(true);
      const homePath = await invoke<string>('sftp_get_home', { sessionId: sid });
      setLeftPath(homePath);
      const entries = await invoke<FileEntry[]>('sftp_list_remote', { sessionId: sid, path: homePath });
      setLeftEntries(entries);
    } catch (e) {
      setLeftConnectError(String(e));
      setLeftState('picking');
    } finally {
      setLeftConnectingId(null);
      setLeftLoading(false);
    }
  }

  async function handleLeftDisconnect() {
    if (leftSid) {
      await invoke('sftp_disconnect_remote', { sessionId: leftSid }).catch(() => {});
    }
    setLeftState('idle');
    setLeftSid(null);
    setLeftServerId(null);
    setLeftEntries([]);
    setLeftPath('');
    setLeftServerName('');
    setLeftError('');
    setLeftDisconnected(false);
  }

  async function handleSftpConnect(server: Server) {
    // Resume existing session for this host
    if (server.id === remoteServerId && remoteSid) {
      setRemoteState('connected');
      return;
    }
    const identity = identities.find((i) => i.id === server.identity_id);
    if (!identity) {
      setConnectError(`No identity configured for "${server.name}". Add one in Hosts settings.`);
      return;
    }

    setConnectingId(server.id);
    setConnectError('');

    try {
      const sid = await invoke<string>('sftp_connect_remote', {
        serverId: server.id,
        username: identity.username,
        authType: 'key',
        authValue: identity.key_id,
      });

      setRemoteSid(sid);
      setRemoteServerId(server.id);
      setRemoteServerName(server.name);
      setRemoteState('connected');
      setRemoteDisconnected(false);
      setRemoteError('');
      setRemoteLoading(true);

      const homePath = await invoke<string>('sftp_get_home', { sessionId: sid });
      setRemotePath(homePath);
      const entries = await invoke<FileEntry[]>('sftp_list_remote', { sessionId: sid, path: homePath });
      setRemoteEntries(entries);
    } catch (e) {
      setConnectError(String(e));
      setRemoteState('picking');
    } finally {
      setConnectingId(null);
      setRemoteLoading(false);
    }
  }

  async function handleRenameLocal(entry: FileEntry, newName: string) {
    const parent = entry.path.substring(0, entry.path.lastIndexOf('/'));
    const newPath = parent + '/' + newName;
    try {
      await invoke('sftp_rename_local', { oldPath: entry.path, newPath });
      await navigateLocal(localPath);
    } catch (e) { setLocalError(String(e)); }
  }

  async function handleDeleteLocal(entry: FileEntry) {
    try {
      await invoke('sftp_delete_local', { path: entry.path });
      await navigateLocal(localPath);
    } catch (e) { setLocalError(String(e)); }
  }

  async function handleRenameRemote(entry: FileEntry, newName: string) {
    if (!remoteSid) return;
    const parent = entry.path.substring(0, entry.path.lastIndexOf('/')) || '/';
    const newPath = (parent === '/' ? '' : parent) + '/' + newName;
    try {
      await invoke('sftp_rename_remote', { sessionId: remoteSid, oldPath: entry.path, newPath });
      await navigateRemote(remotePath);
    } catch (e) { setRemoteError(String(e)); }
  }

  async function handleDeleteRemote(entry: FileEntry) {
    if (!remoteSid) return;
    try {
      await invoke('sftp_delete_remote', { sessionId: remoteSid, path: entry.path, isDir: entry.is_dir });
      await navigateRemote(remotePath);
    } catch (e) { setRemoteError(String(e)); }
  }

  async function handleDrop(targetPanel: 'left' | 'right', entry: FileEntry) {
    const leftIsLocal = leftState === 'local';
    const rightIsLocal = remoteState === 'local';
    const leftIsRemote = leftState === 'connected';
    const rightIsRemote = remoteState === 'connected';

    // Determine which session/paths are involved
    let uploadCmd: (() => Promise<void>) | null = null;

    if (targetPanel === 'right' && rightIsRemote && leftIsLocal) {
      uploadCmd = async () => {
        await invoke('sftp_upload', { sessionId: remoteSid, localPath: entry.path, remoteDir: remotePath });
        await navigateRemote(remotePath);
      };
    } else if (targetPanel === 'left' && leftIsLocal && rightIsRemote) {
      uploadCmd = async () => {
        await invoke('sftp_download', { sessionId: remoteSid, remotePath: entry.path, localDir: localPath });
        await navigateLocal(localPath);
      };
    } else if (targetPanel === 'right' && rightIsRemote && leftIsRemote) {
      uploadCmd = async () => {
        await invoke('sftp_copy_remote_to_remote', { srcSessionId: leftSid, srcPath: entry.path, dstSessionId: remoteSid, dstDir: remotePath });
        await navigateRemote(remotePath);
      };
    } else if (targetPanel === 'left' && leftIsRemote && rightIsRemote) {
      uploadCmd = async () => {
        await invoke('sftp_copy_remote_to_remote', { srcSessionId: remoteSid, srcPath: entry.path, dstSessionId: leftSid, dstDir: leftPath });
        await navigateLeftRemote(leftPath);
      };
    } else if (targetPanel === 'right' && rightIsLocal && leftIsRemote) {
      uploadCmd = async () => {
        await invoke('sftp_download', { sessionId: leftSid, remotePath: entry.path, localDir: rightLocalPath });
        await navigateRightLocal(rightLocalPath);
      };
    } else if (targetPanel === 'left' && leftIsRemote && rightIsLocal) {
      uploadCmd = async () => {
        await invoke('sftp_upload', { sessionId: leftSid, localPath: entry.path, remoteDir: leftPath });
        await navigateLeftRemote(leftPath);
      };
    }

    if (!uploadCmd) return;
    setTransferring(true);
    setTransferTarget(targetPanel);
    setDropTarget(null);
    try { await uploadCmd(); }
    catch (e) { console.error('Transfer failed:', e); }
    finally { setTransferring(false); setTransferTarget(null); setProgress(null); }
  }

  async function handleNewLocalFolder(name: string) {
    const path = localPath.replace(/\/$/, '') + '/' + name;
    try {
      await invoke('sftp_create_local_dir', { path });
      await navigateLocal(localPath);
    } catch (e) {
      setLocalError(String(e));
    }
  }

  async function handleNewRemoteFolder(name: string) {
    if (!remoteSid) return;
    const path = remotePath.replace(/\/$/, '') + '/' + name;
    try {
      await invoke('sftp_mkdir', { sessionId: remoteSid, path });
      await navigateRemote(remotePath);
    } catch (e) {
      setRemoteError(String(e));
    }
  }

  async function handleNewLeftRemoteFolder(name: string) {
    if (!leftSid) return;
    const path = leftPath.replace(/\/$/, '') + '/' + name;
    try {
      await invoke('sftp_mkdir', { sessionId: leftSid, path });
      await navigateLeftRemote(leftPath);
    } catch (e) { setLeftError(String(e)); }
  }

  async function handleRenameLeftRemote(entry: FileEntry, newName: string) {
    if (!leftSid) return;
    const parent = entry.path.substring(0, entry.path.lastIndexOf('/')) || '/';
    const newPath = (parent === '/' ? '' : parent) + '/' + newName;
    try {
      await invoke('sftp_rename_remote', { sessionId: leftSid, oldPath: entry.path, newPath });
      await navigateLeftRemote(leftPath);
    } catch (e) { setLeftError(String(e)); }
  }

  async function handleDeleteLeftRemote(entry: FileEntry) {
    if (!leftSid) return;
    try {
      await invoke('sftp_delete_remote', { sessionId: leftSid, path: entry.path, isDir: entry.is_dir });
      await navigateLeftRemote(leftPath);
    } catch (e) { setLeftError(String(e)); }
  }

  async function handleRenameRightLocal(entry: FileEntry, newName: string) {
    const parent = entry.path.substring(0, entry.path.lastIndexOf('/'));
    const newPath = parent + '/' + newName;
    try {
      await invoke('sftp_rename_local', { oldPath: entry.path, newPath });
      await navigateRightLocal(rightLocalPath);
    } catch (e) { setRightLocalError(String(e)); }
  }

  async function handleDeleteRightLocal(entry: FileEntry) {
    try {
      await invoke('sftp_delete_local', { path: entry.path });
      await navigateRightLocal(rightLocalPath);
    } catch (e) { setRightLocalError(String(e)); }
  }

  async function handleNewRightLocalFolder(name: string) {
    const path = rightLocalPath.replace(/\/$/, '') + '/' + name;
    try {
      await invoke('sftp_create_local_dir', { path });
      await navigateRightLocal(rightLocalPath);
    } catch (e) { setRightLocalError(String(e)); }
  }

  async function handleDisconnect() {
    if (remoteSid) {
      await invoke('sftp_disconnect_remote', { sessionId: remoteSid }).catch(() => {});
    }
    setRemoteState('idle');
    setRemoteSid(null);
    setRemoteServerId(null);
    setRemoteEntries([]);
    setRemotePath('');
    setRemoteServerName('');
    setRemoteError('');
    setRemoteDisconnected(false);
  }

  const localIcon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
      <polyline points="9,22 9,12 15,12 15,22" />
    </svg>
  );

  const remoteIcon = (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );

  const closeConnectionActions = (onClose: () => void) => (
    <>
      <div className="sftp-dropdown-divider" />
      <button className="sftp-dropdown-item sftp-dropdown-item-danger" onClick={onClose}>
        Close Connection
      </button>
    </>
  );

  return (
    <div className="sftp-container">
      <div className="sftp-panels-row">
      {/* Left panel */}
      <div className={`sftp-file-panel${dropTarget === 'left' ? ' sftp-drop-target' : ''}`}>
        {dropTarget === 'left' && !transferring && (
          <div className="sftp-drop-overlay"><span>Drop to copy here</span></div>
        )}
        {leftState === 'local' && (
          <FileBrowser
            title="Local"
            icon={localIcon}
            path={localPath}
            entries={localEntries}
            loading={localLoading}
            error={localError}
            onNavigate={navigateLocal}
            onRefresh={() => navigateLocal(localPath)}
            onNewFolder={handleNewLocalFolder}
            canCopyToTarget={remoteState === 'connected'}
            onCopyToTarget={(entry) => handleDrop('right', entry)}
            onRename={handleRenameLocal}
            onDelete={handleDeleteLocal}
            onLocalBtn={() => setLeftState('idle')}
            extraActions={closeConnectionActions(() => setLeftState('idle'))}
            side="left"
            isDropTarget={dropTarget === 'left'}
            transferring={transferring && transferTarget === 'left'}
            onDragEnter={() => setDropTarget('left')}
            onDragLeave={() => setDropTarget(p => p === 'left' ? null : p)}
            onFileDrop={(entry) => handleDrop('left', entry)}
          />
        )}

        {leftState === 'idle' && (
          <ConnectPrompt
            onSelectHost={() => setLeftState('picking')}
            onGoLocal={() => setLeftState('local')}
          />
        )}

        {leftState === 'picking' && (
          <HostPicker
            servers={servers}
            connectingId={leftConnectingId}
            activeServerId={leftServerId}
            error={leftConnectError}
            onConnect={handleLeftSftpConnect}
            onBack={() => { setLeftState('idle'); setLeftConnectError(''); }}
            onGoLocal={() => setLeftState('local')}
          />
        )}

        {leftState === 'connected' && (
          <FileBrowser
            title={leftServerName}
            icon={remoteIcon}
            path={leftPath}
            entries={leftEntries}
            loading={leftLoading}
            error={leftError}
            onNavigate={navigateLeftRemote}
            onRefresh={() => navigateLeftRemote(leftPath)}
            onNewFolder={handleNewLeftRemoteFolder}
            canCopyToTarget={remoteState === 'local' || remoteState === 'connected'}
            onCopyToTarget={(entry) => handleDrop('right', entry)}
            onRename={handleRenameLeftRemote}
            onDelete={handleDeleteLeftRemote}
            onLocalBtn={() => setLeftState('idle')}
            extraActions={closeConnectionActions(handleLeftDisconnect)}
            side="left"
            isDropTarget={dropTarget === 'left'}
            transferring={transferring && transferTarget === 'left'}
            onDragEnter={() => setDropTarget('left')}
            onDragLeave={() => setDropTarget(p => p === 'left' ? null : p)}
            onFileDrop={(entry) => handleDrop('left', entry)}
            onReconnect={leftDisconnected ? () => {
              const s = servers.find(sv => sv.id === leftServerId);
              if (s) handleLeftSftpConnect(s);
            } : undefined}
          />
        )}
      </div>

      <div className="sftp-divider" />

      {/* Right panel */}
      <div className={`sftp-file-panel sftp-remote-panel${dropTarget === 'right' ? ' sftp-drop-target' : ''}`}>
        {dropTarget === 'right' && !transferring && (
          <div className="sftp-drop-overlay"><span>Drop to copy here</span></div>
        )}
        {remoteState === 'idle' && (
          <ConnectPrompt
            onSelectHost={() => setRemoteState('picking')}
            onGoLocal={openRightLocal}
          />
        )}

        {remoteState === 'local' && (
          <FileBrowser
            title="Local"
            icon={localIcon}
            path={rightLocalPath}
            entries={rightLocalEntries}
            loading={rightLocalLoading}
            error={rightLocalError}
            onNavigate={navigateRightLocal}
            onRefresh={() => navigateRightLocal(rightLocalPath)}
            onNewFolder={handleNewRightLocalFolder}
            canCopyToTarget={leftState === 'connected'}
            onCopyToTarget={(entry) => handleDrop('left', entry)}
            onRename={handleRenameRightLocal}
            onDelete={handleDeleteRightLocal}
            onLocalBtn={() => setRemoteState('idle')}
            extraActions={closeConnectionActions(() => setRemoteState('idle'))}
            side="right"
            isDropTarget={dropTarget === 'right'}
            transferring={transferring && transferTarget === 'right'}
            onDragEnter={() => setDropTarget('right')}
            onDragLeave={() => setDropTarget(p => p === 'right' ? null : p)}
            onFileDrop={(entry) => handleDrop('right', entry)}
          />
        )}

        {remoteState === 'picking' && (
          <HostPicker
            servers={servers}
            connectingId={connectingId}
            activeServerId={remoteServerId}
            error={connectError}
            onConnect={handleSftpConnect}
            onBack={() => { setRemoteState('idle'); setConnectError(''); }}
            onGoLocal={openRightLocal}
          />
        )}

        {remoteState === 'connected' && (
          <FileBrowser
            title={remoteServerName}
            icon={remoteIcon}
            path={remotePath}
            entries={remoteEntries}
            loading={remoteLoading}
            error={remoteError}
            onNavigate={navigateRemote}
            onRefresh={() => navigateRemote(remotePath)}
            onNewFolder={handleNewRemoteFolder}
            canCopyToTarget={leftState === 'local' || leftState === 'connected'}
            onCopyToTarget={(entry) => handleDrop('left', entry)}
            onRename={handleRenameRemote}
            onDelete={handleDeleteRemote}
            onLocalBtn={() => setRemoteState('idle')}
            extraActions={closeConnectionActions(handleDisconnect)}
            side="right"
            isDropTarget={dropTarget === 'right'}
            transferring={transferring && transferTarget === 'right'}
            onDragEnter={() => setDropTarget('right')}
            onDragLeave={() => setDropTarget(p => p === 'right' ? null : p)}
            onFileDrop={(entry) => handleDrop('right', entry)}
            onReconnect={remoteDisconnected ? () => {
              const s = servers.find(sv => sv.id === remoteServerId);
              if (s) handleSftpConnect(s);
            } : undefined}
          />
        )}
      </div>
      </div>{/* end sftp-panels-row */}
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
              <span className="sftp-progress-name">{progress.file_name}</span>
              <span className="sftp-progress-stat">{pct}% · {speedStr}{speedStr ? ' · ' : ''}ETA {eta}</span>
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
