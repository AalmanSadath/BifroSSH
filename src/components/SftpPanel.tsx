import { useState, useEffect, useRef } from 'react';
import * as ipc from '../ipc';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import { useAppStore, buildJumpChain, resolveServerAuth } from '../store/appStore';
import OsIcon from './OsIcon';
import { matchesHost } from '../hosts';
import type { Conflict, EditEvent, FileEntry, LogEntry, Server, TransferProgress, TransferSummary } from '../types';
import ConnectingView from './ConnectingView';
import ContextMenu from './shared/ContextMenu';
import PermissionsDialog, { type OwnerChange } from './PermissionsDialog';
import ConflictDialog, { type ConflictAnswer, type ConflictPrompt } from './ConflictDialog';
import { useDismissOnOutside } from './shared/useDismissOnOutside';
import { localStyle, remoteStyle, resolveTyped, styleFor, type PathStyle } from '../paths';

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

const HEADERS = ['Name', 'Date Modified', 'Size', 'Owner', 'Type'] as const;
type SortCol = typeof HEADERS[number];
const DEFAULT_COL_WIDTHS = [38, 22, 10, 14, 16];

/**
 * A message over the list. An error is painted so it looks like one; a
 * report of something that went fine, a transfer summary or an upload
 * behind an opened file, is painted so it does not.
 */
interface Notice {
  text: string;
  kind: 'error' | 'info';
}

interface FileBrowserProps {
  title: React.ReactNode;
  icon: React.ReactNode;
  path: string;
  /** Where `~` goes when typed into the bar. Null until the pane knows. */
  home: string | null;
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
  notice?: Notice | null;
  onDismissNotice?: () => void;
  onNavigate: (path: string) => void;
  onRefresh?: () => void;
  onNewFolder?: (name: string) => void;
  extraActions?: React.ReactNode;
  onLocalBtn?: () => void;
  canCopyToTarget?: boolean;
  onCopyToTarget?: (entries: FileEntry[]) => void;
  onRename?: (entry: FileEntry, newName: string) => void;
  onDelete?: (entries: FileEntry[]) => void;
  onSetMode?: (entries: FileEntry[], mode: number, owner: OwnerChange | null) => void;
  /** A file, double-clicked or chosen from the menu. */
  onOpen?: (entry: FileEntry) => void;
  /** A same-pane drop onto a directory row. */
  onMove?: (entries: FileEntry[], intoDir: string) => void;
  side?: 'left' | 'right';
  isDropTarget?: boolean;
  transferring?: boolean;
  onDragEnter?: () => void;
  onDragLeave?: () => void;
  onFileDrop?: (entries: FileEntry[], fromSide: 'left' | 'right') => void;
  onReconnect?: () => void;
  /** How to take this pane's paths apart: POSIX remotely, native locally. */
  pathStyle: PathStyle;
}

function FileBrowser({ title, icon, path, home, entries, loading, error, notice, onDismissNotice, onNavigate,
  onRefresh, onNewFolder, extraActions, onLocalBtn,
  canCopyToTarget, onCopyToTarget, onRename, onDelete, onSetMode, onOpen, onMove,
  side, isDropTarget, transferring, onDragEnter: onDragEnterCb, onDragLeave: onDragLeaveCb, onFileDrop, onReconnect,
  pathStyle,
}: FileBrowserProps) {
  const { settings } = useAppStore();
  const hint = (t: string) => settings.show_hover_hints ? t : undefined;
  const segments = pathStyle.segments(path);
  /** The bar as a text field: the text being typed, or null for crumbs. */
  const [typedPath, setTypedPath] = useState<string | null>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);

  function startTyping() {
    setTypedPath(path);
    setTimeout(() => { pathInputRef.current?.focus(); pathInputRef.current?.select(); }, 30);
  }

  function commitTyped() {
    if (typedPath === null) return;
    const target = resolveTyped(typedPath, path, home, pathStyle);
    setTypedPath(null);
    if (target !== null) onNavigate(target);
  }
  const [colWidths, setColWidths] = useState(DEFAULT_COL_WIDTHS);
  const [sortCol, setSortCol] = useState<SortCol>('Name');
  const [sortAsc, setSortAsc] = useState(true);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);
  const [dirsOnTop, setDirsOnTop] = useState(true);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; entry: FileEntry | null } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<FileEntry[] | null>(null);
  const [permEntries, setPermEntries] = useState<FileEntry[] | null>(null);
  const [newFolderName, setNewFolderName] = useState<string | null>(null);
  const [renamingEntry, setRenamingEntry] = useState<{ entry: FileEntry; value: string } | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const tableRef = useRef<HTMLTableElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const newFolderInputRef = useRef<HTMLInputElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const dragCountRef = useRef(0);
  /** A drag that started in this pane, for which the copy overlay is wrong. */
  const dragFromHereRef = useRef(false);
  /** The directory row a same-pane drag is hovering, for its highlight. */
  const [rowDropPath, setRowDropPath] = useState<string | null>(null);
  const lastClickIdxRef = useRef(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  /** The row the arrow keys move from. An index into `visible`, or -1. */
  const cursorRef = useRef(-1);
  /** Typed over the list to narrow it; null when the bar is closed. */
  const [filter, setFilter] = useState<string | null>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setSelectedPaths(new Set());
    lastClickIdxRef.current = -1;
    setFilter(null);
  }, [path]);

  // A different filter is a different list; the selection meant the old one.
  useEffect(() => {
    setSelectedPaths(new Set());
    cursorRef.current = -1;
    lastClickIdxRef.current = -1;
  }, [filter]);

  /** Opens the bar with `seed` in it and the caret after it. */
  function startFilter(seed: string) {
    setFilter(seed);
    setTimeout(() => {
      const el = filterInputRef.current;
      if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); }
    }, 30);
  }

  function closeFilter() {
    setFilter(null);
    setTimeout(() => wrapRef.current?.focus(), 0);
  }

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

  /**
   * The rows in the order they are drawn: `..` first, then the rest sorted and
   * with hidden files left out unless asked for. Row indexes mean this order,
   * so anything that turns an index back into entries has to use it too. The
   * shift range used to slice `entries`, the unsorted prop, so a range over
   * rows 3 to 6 selected whichever files happened to sit at 3 to 6 in
   * directory order.
   */
  const visible: FileEntry[] = (() => {
    const dotdot = entries.filter(en => en.name === '..');
    const needle = filter?.toLowerCase() ?? '';
    const rest = entries
      .filter(en => en.name !== '..' && (showHidden || !en.hidden))
      .filter(en => needle === '' || en.name.toLowerCase().includes(needle))
      .sort((a, b) => {
        if (dirsOnTop && a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
        let cmp = 0;
        if (sortCol === 'Name') cmp = a.name.localeCompare(b.name);
        else if (sortCol === 'Date Modified') cmp = (a.modified ?? 0) - (b.modified ?? 0);
        else if (sortCol === 'Size') cmp = a.size - b.size;
        else if (sortCol === 'Owner') cmp = a.owner.localeCompare(b.owner);
        else if (sortCol === 'Type') cmp = a.kind.localeCompare(b.kind);
        return sortAsc ? cmp : -cmp;
      });
    return [...dotdot, ...rest];
  })();

  function handleRowClick(e: React.MouseEvent, entry: FileEntry, idx: number) {
    if (entry.name === '..') return;
    cursorRef.current = idx;
    wrapRef.current?.focus();
    if (e.shiftKey && lastClickIdxRef.current >= 0) {
      const start = Math.min(lastClickIdxRef.current, idx);
      const end = Math.max(lastClickIdxRef.current, idx);
      const range = visible.slice(start, end + 1).filter(en => en.name !== '..');
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

  /** Selects the rows between the anchor and `idx`, both ends included. */
  function selectRange(idx: number) {
    const anchor = lastClickIdxRef.current >= 0 ? lastClickIdxRef.current : idx;
    const start = Math.min(anchor, idx);
    const end = Math.max(anchor, idx);
    setSelectedPaths(new Set(
      visible.slice(start, end + 1).filter((en) => en.name !== '..').map((en) => en.path),
    ));
  }

  /**
   * Keys on the list. Row indexes mean `visible`, the same as a click, so a
   * resort moves the cursor with the rows rather than leaving it pointing at
   * a position. The rename and new-folder fields sit inside this container
   * and own their own keys, so anything from an input is left alone.
   */
  function handleKeyDown(e: React.KeyboardEvent) {
    if ((e.target as HTMLElement).tagName === 'INPUT') return;
    const rows = visible;
    const selectable = (i: number) => i >= 0 && i < rows.length && rows[i].name !== '..';

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      setSelectedPaths(new Set(rows.filter((en) => en.name !== '..').map((en) => en.path)));
      return;
    }
    // The file manager and browser key for "type a location".
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
      e.preventDefault();
      startTyping();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      startFilter(filter ?? '');
      return;
    }
    if (e.key === 'Escape') {
      if (filter !== null) closeFilter();
      else setSelectedPaths(new Set());
      return;
    }
    // Any other printable key on its own starts narrowing the list.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      startFilter((filter ?? '') + e.key);
      return;
    }
    if (e.key === 'Delete') {
      const chosen = rows.filter((en) => en.name !== '..' && selectedPaths.has(en.path));
      if (chosen.length > 0 && onDelete) {
        e.preventDefault();
        setConfirmDelete(chosen);
      }
      return;
    }
    if (e.key === 'Enter') {
      const chosen = rows.filter((en) => selectedPaths.has(en.path));
      if (chosen.length === 1 && chosen[0].is_dir) {
        e.preventDefault();
        onNavigate(chosen[0].path);
      }
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      // From the cursor if there is one, else onto the first real row.
      let next = cursorRef.current >= 0 ? cursorRef.current + step : rows.findIndex((en) => en.name !== '..');
      // `..` is not a row the cursor stops on.
      if (next >= 0 && next < rows.length && rows[next].name === '..') next += step;
      if (!selectable(next)) return;
      cursorRef.current = next;
      if (e.shiftKey) {
        selectRange(next);
      } else {
        setSelectedPaths(new Set([rows[next].path]));
        lastClickIdxRef.current = next;
      }
      // By index attribute rather than nth .sftp-row: the new-folder input
      // row shares the class and would put the count off by one.
      requestAnimationFrame(() => {
        wrapRef.current
          ?.querySelector<HTMLElement>(`[data-idx="${next}"]`)
          ?.scrollIntoView({ block: 'nearest' });
      });
    }
  }

  /**
   * The entries an action on `entry` applies to: the whole selection when the
   * entry is part of it, otherwise that entry alone. Dragging one row of a
   * highlighted set used to carry only that row, so a multi-select copied one
   * file and quietly dropped the rest.
   */
  function batchFor(entry: FileEntry): FileEntry[] {
    if (!selectedPaths.has(entry.path)) return [entry];
    return visible.filter((en) => en.name !== '..' && selectedPaths.has(en.path));
  }

  function handleDragStart(e: React.DragEvent, entry: FileEntry) {
    e.dataTransfer.setData('text/plain', JSON.stringify({ side, entries: batchFor(entry) }));
    e.dataTransfer.effectAllowed = 'copyMove';
    dragFromHereRef.current = true;
  }

  function handleDragEnd() {
    dragFromHereRef.current = false;
    setRowDropPath(null);
  }

  function handleDragOver(e: React.DragEvent) {
    if (!onFileDrop) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = dragFromHereRef.current ? 'move' : 'copy';
  }

  function handleDragEnter(e: React.DragEvent) {
    if (!onFileDrop) return;
    e.preventDefault();
    dragCountRef.current++;
    // A drag that began here can only move into a folder row, so the
    // pane-wide "Drop to copy here" would promise something else.
    if (dragCountRef.current === 1 && !dragFromHereRef.current) onDragEnterCb?.();
  }

  function handleDragLeave() {
    if (!onFileDrop) return;
    dragCountRef.current--;
    if (dragCountRef.current === 0) setTimeout(() => { if (dragCountRef.current === 0) onDragLeaveCb?.(); }, 0);
  }

  /** The payload of one of our own drags, or null for anything else. */
  function readDragPayload(e: React.DragEvent): { fromSide: 'left' | 'right'; dropped: FileEntry[] } | null {
    const raw = e.dataTransfer.getData('text/plain');
    if (!raw) return null;
    try {
      const { side: fromSide, entries: dropped } = JSON.parse(raw) as {
        side: 'left' | 'right';
        entries: FileEntry[];
      };
      return dropped.length > 0 ? { fromSide, dropped } : null;
    } catch {
      // A drag from outside the app carries whatever that app put on the
      // clipboard, which is not this payload. Nothing to do and nothing worth
      // saying: the drop simply is not one of ours.
      return null;
    }
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCountRef.current = 0;
    onDragLeaveCb?.();
    if (!onFileDrop) return;
    const payload = readDragPayload(e);
    if (payload && payload.fromSide !== side) onFileDrop(payload.dropped, payload.fromSide);
  }

  /** A drop on a directory row: a move when it came from this pane. */
  function handleRowDrop(e: React.DragEvent, dir: FileEntry) {
    const payload = readDragPayload(e);
    if (!payload || payload.fromSide !== side) return;
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current = 0;
    setRowDropPath(null);
    onMove?.(payload.dropped, dir.path);
  }

  function handleRowDragOver(e: React.DragEvent, dir: FileEntry) {
    if (!dragFromHereRef.current || !onMove) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (rowDropPath !== dir.path) setRowDropPath(dir.path);
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

      {/* Crumbs, or a text field in their place. Clicking the bar itself,
          rather than a crumb, is what opens the field; there is no button
          for it, the same as in GNOME Files and Explorer. Blur puts the
          crumbs back without navigating; Enter navigates. */}
      {typedPath !== null ? (
        <div className="sftp-breadcrumb sftp-breadcrumb-typing">
          <input
            ref={pathInputRef}
            className="sftp-path-input"
            value={typedPath}
            spellCheck={false}
            onChange={(e) => setTypedPath(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitTyped();
              if (e.key === 'Escape') setTypedPath(null);
            }}
            onBlur={() => setTypedPath(null)}
          />
        </div>
      ) : (
        <div
          className="sftp-breadcrumb"
          title={hint('Click to type a path')}
          onClick={(e) => { if (e.target === e.currentTarget) startTyping(); }}
        >
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
      )}

      {filter !== null && (
        <div className="sftp-filter-bar">
          <span className="sftp-filter-glyph" aria-hidden>⌕</span>
          <input
            ref={filterInputRef}
            className="sftp-filter-input"
            value={filter}
            placeholder="Filter by name"
            spellCheck={false}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f')) { e.preventDefault(); closeFilter(); }
              // Enter, or an arrow, hands the keyboard to the list with the
              // first match under the cursor, so Enter again opens it.
              else if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const first = visible.findIndex((en) => en.name !== '..');
                if (first >= 0) {
                  cursorRef.current = first;
                  lastClickIdxRef.current = first;
                  setSelectedPaths(new Set([visible[first].path]));
                }
                wrapRef.current?.focus();
              }
            }}
          />
          <span className="sftp-filter-count">
            {visible.filter((en) => en.name !== '..').length} of {entries.filter((en) => en.name !== '..' && (showHidden || !en.hidden)).length}
          </span>
          <button className="sftp-filter-close" onClick={closeFilter} title="Clear filter" aria-label="Clear filter">✕</button>
        </div>
      )}

      <div
        className="sftp-table-wrap"
        ref={wrapRef}
        tabIndex={0}
        onKeyDown={handleKeyDown}
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
                <td colSpan={HEADERS.length}>
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
            {loading && entries.length === 0 ? (
              <tr><td colSpan={HEADERS.length} className="sftp-status-cell">Loading…</td></tr>
            ) : error ? (
              <tr><td colSpan={HEADERS.length} className="sftp-status-cell sftp-cell-error">{error}</td></tr>
            ) : visible.map((entry, idx) => (
              <tr
                key={entry.path}
                data-idx={idx}
                className={`sftp-row${selectedPaths.has(entry.path) ? ' sftp-row-selected' : ''}${rowDropPath === entry.path ? ' sftp-row-drop-target' : ''}`}
                draggable={entry.name !== '..'}
                onClick={(e) => handleRowClick(e, entry, idx)}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setContextMenu({ x: e.clientX, y: e.clientY, entry }); }}
                onDragStart={(e) => entry.name !== '..' && handleDragStart(e, entry)}
                onDragEnd={handleDragEnd}
                onDragOver={entry.is_dir ? (e) => handleRowDragOver(e, entry) : undefined}
                onDragLeave={entry.is_dir ? () => setRowDropPath((p) => (p === entry.path ? null : p)) : undefined}
                onDrop={entry.is_dir ? (e) => handleRowDrop(e, entry) : undefined}
                onDoubleClick={() => (entry.is_dir ? onNavigate(entry.path) : onOpen?.(entry))}
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
                    {!renamingEntry && entry.symlink && (
                      <span className="sftp-link-tag" title="A symbolic link. Size and type are its target's.">
                        link
                      </span>
                    )}
                    {!renamingEntry && entry.permissions && (
                      <span className="sftp-perms">{entry.permissions}</span>
                    )}
                  </div>
                </td>
                <td>{formatDate(entry.modified)}</td>
                <td>{formatSize(entry.size, entry.is_dir)}</td>
                <td className="sftp-owner-cell" title={entry.owner}>{entry.owner}</td>
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
              {!contextMenu.entry.is_dir && onOpen && (
                <button className="menu-item" onClick={() => { onOpen(contextMenu.entry!); setContextMenu(null); }}>
                  Open
                </button>
              )}
              {canCopyToTarget && (
                <button className="menu-item" onClick={() => { onCopyToTarget?.(batchFor(contextMenu.entry!)); setContextMenu(null); }}>
                  Copy to Target
                </button>
              )}
              <button className="menu-item" onClick={() => handleRenameClick(contextMenu.entry!)}>
                Rename
              </button>
              {contextMenu.entry.mode !== null && onSetMode && (
                <button className="menu-item" onClick={() => { setPermEntries(batchFor(contextMenu.entry!)); setContextMenu(null); }}>
                  Permissions…
                </button>
              )}
              <div className="menu-divider" />
              <button className="menu-item menu-item-danger" onClick={() => { setConfirmDelete(batchFor(contextMenu.entry!)); setContextMenu(null); }}>
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
        <div className={`sftp-notice${notice.kind === 'info' ? ' sftp-notice-info' : ''}`}>
          <span className="sftp-notice-text">{notice.text}</span>
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
            <p className="sftp-confirm-title">
              {confirmDelete.length === 1
                ? `Delete "${confirmDelete[0].name}"?`
                : `Delete ${confirmDelete.length} items?`}
            </p>
            <p className="sftp-confirm-sub">This cannot be undone.</p>
            <div className="sftp-confirm-actions">
              <button className="sftp-action-btn" onClick={() => setConfirmDelete(null)}>Cancel</button>
              <button className="sftp-confirm-delete-btn" onClick={() => { onDelete?.(confirmDelete); setConfirmDelete(null); }}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {permEntries && (
        <PermissionsDialog
          entries={permEntries}
          onCancel={() => setPermEntries(null)}
          onApply={(mode, owner) => { onSetMode?.(permEntries, mode, owner); setPermEntries(null); }}
        />
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
  const [query, setQuery] = useState('');
  const shown = servers.filter((s) => matchesHost(s, query));
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
      {servers.length > 0 && (
        <div className="sftp-picker-search">
          <input
            type="text"
            placeholder="Filter by name, host, user or group"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            autoFocus
          />
        </div>
      )}
      <div className="sftp-picker-list">
        {servers.length === 0 ? (
          <div className="sftp-picker-empty">No hosts configured. Add one in Hosts.</div>
        ) : shown.length === 0 ? (
          <div className="sftp-picker-empty">No hosts match.</div>
        ) : shown.map((s) => (
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
  /** The home directory, once fetched, so a typed `~` has somewhere to go. */
  home: string | null;
}

const emptyListing = (loading: boolean): Listing => ({ path: '', entries: [], loading, error: '', home: null });

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
  const [notice, setNotice] = useState<Notice | null>(null);

  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState('');
  const [connectLogs, setConnectLogs] = useState<LogEntry[]>([]);
  const [connectServer, setConnectServer] = useState<Server | null>(null);

  // The watcher behind an opened file reports on a channel named for the
  // session. Through a ref so the listener, bound once per session, calls
  // the refresh of the render it fires in rather than the one it was made in.
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    if (!sid) return;
    const unlisten = listen<EditEvent>(`sftp-edit:${sid}`, (e) => {
      const { name, error } = e.payload;
      setNotice(error
        ? { text: `Could not upload ${name}: ${error}`, kind: 'error' }
        : { text: `Uploaded ${name}`, kind: 'info' });
      refreshRef.current();
    });
    return () => { unlisten.then((f) => f()); };
  }, [sid]);

  /** The listing the pane is currently showing, whichever side it is on. */
  const listing = mode === 'local' ? local : remote;
  const style = styleFor(mode === 'local' ? 'local' : 'remote');

  // The path and the rows change together, once the listing is in hand.
  // Switching the path first and the rows after showed the new crumbs over a
  // "Loading…" row, and a listing that then failed switched everything back:
  // a flicker for a directory the user could not read.
  async function navigateLocal(path: string) {
    if (path !== local.path) setNotice(null);
    setLocal((l) => ({ ...l, loading: true, error: '' }));
    try {
      const entries = await ipc.sftpListLocal(path);
      setLocal((l) => ({ ...l, path, entries, loading: false }));
    } catch (e) {
      setLocal((l) => ({ ...l, loading: false }));
      fail(String(e));
    }
  }

  async function navigateRemote(path: string, on: string | null = sid) {
    if (!on) return;
    const sid = on;
    if (path !== remote.path) setNotice(null);
    setRemote((r) => ({ ...r, loading: true, error: '' }));
    try {
      const entries = await ipc.sftpListRemote(sid, path);
      setRemote((r) => ({ ...r, path, entries, loading: false }));
    } catch (e) {
      // A listing fails for a path that is not there, or not readable, as
      // readily as for a link that has died, and every failure used to be
      // read as the second: a mistyped path put up the reconnect button. The
      // session is asked whether it still answers, and only silence is a
      // disconnect.
      const alive = await ipc.sftpProbeRemote(sid).catch(() => false);
      if (alive) {
        setRemote((r) => ({ ...r, loading: false }));
        fail(String(e));
        return;
      }
      setRemote((r) => ({ ...r, error: String(e), loading: false }));
      setDisconnected(true);
      setSid(null);
    }
  }

  /** Re-lists whichever side is showing, after a change made to it. */
  const refresh = () => (mode === 'local' ? navigateLocal(local.path) : navigateRemote(remote.path));
  refreshRef.current = refresh;

  /** Shows the local disk, fetching the home directory the first time only. */
  async function goLocal() {
    setMode('local');
    if (!local.path) {
      const home = await ipc.sftpLocalHome().catch(() => localStyle().defaultRoot);
      setLocal((l) => ({ ...l, home }));
      await navigateLocal(home);
    }
  }

  /** Resolves to the session id once the pane is on `server`, or null when it could not get there. */
  async function connect(server: Server): Promise<string | null> {
    // Resume the session already open for this host rather than making another.
    if (server.id === serverId && sid) {
      setMode('connected');
      return sid;
    }

    const resolved = await resolveServerAuth(server, identities);
    if (!resolved) {
      setConnectError(`No authentication configured for "${server.name}". Add a key, password or prompt auth in Hosts settings.`);
      return null;
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
      useAppStore.getState().autostartTunnels({ kind: 'connect', serverId: server.id });

      const home = await ipc.sftpGetHome(newSid);
      const entries = await ipc.sftpListRemote(newSid, home);
      setRemote({ path: home, entries, loading: false, error: '', home });
      return newSid;
    } catch (e) {
      // Stay on the connecting screen so the log explaining the failure, and
      // the retry button, are both still there.
      setConnectError(String(e));
      return null;
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
    const path = style.join(listing.path, name);
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
    // The style knows where the parent ends, which is the whole reason it
    // exists: on Windows this is a backslash and the old lastIndexOf('/')
    // renamed the file into the root of the disk.
    const parent = style.parent(entry.path);
    if (parent === null) {
      fail(`Cannot rename ${entry.name}: it has no parent folder`);
      return;
    }
    try {
      const target = style.join(parent, newName);
      if (mode === 'local') await ipc.sftpRenameLocal(entry.path, target);
      else await ipc.sftpRenameRemote(requireSid(), entry.path, target);
    } catch (e) {
      fail(String(e));
    } finally {
      await refresh();
    }
  }

  async function removeMany(batch: FileEntry[]) {
    try {
      // The first failure stops the batch. The ones before it are gone, the
      // ones after it are untouched, and the refresh below shows exactly that.
      for (const entry of batch) {
        if (mode === 'local') await ipc.sftpDeleteLocal(entry.path);
        else await ipc.sftpDeleteRemote(requireSid(), entry.path, entry.is_dir);
      }
    } catch (e) {
      fail(String(e));
    } finally {
      await refresh();
    }
  }

  async function open(entry: FileEntry) {
    try {
      if (mode === 'local') {
        await ipc.sftpOpenLocal(entry.path);
      } else {
        await ipc.sftpOpenRemote(requireSid(), entry.path);
        say(`Opened ${entry.name}. Each save goes back to the server.`);
      }
    } catch (e) {
      fail(String(e));
    }
  }

  async function moveInto(batch: FileEntry[], dir: string) {
    try {
      for (const entry of batch) {
        if (dir === entry.path || dir.startsWith(entry.path + style.sep)) {
          throw new Error(`Cannot move ${entry.name} into itself`);
        }
        if (style.parent(entry.path) === dir) continue;
        const target = style.join(dir, entry.name);
        if (mode === 'local') await ipc.sftpRenameLocal(entry.path, target);
        else await ipc.sftpRenameRemote(requireSid(), entry.path, target);
      }
    } catch (e) {
      fail(String(e));
    } finally {
      await refresh();
    }
  }

  async function setPerms(batch: FileEntry[], newMode: number, owner: OwnerChange | null) {
    try {
      // The first failure stops the batch, same as removeMany: what came
      // before it is changed, what came after it is not, and the refresh
      // below shows exactly that. The mode goes first: a chown that is
      // refused still leaves the mode the user asked for.
      for (const entry of batch) {
        if (mode === 'local') await ipc.sftpSetModeLocal(entry.path, newMode);
        else await ipc.sftpSetModeRemote(requireSid(), entry.path, newMode);
        if (!owner) continue;
        if (mode === 'local') await ipc.sftpSetOwnerLocal(entry.path, owner.user, owner.group);
        else await ipc.sftpSetOwnerRemote(requireSid(), entry.path, owner.user, owner.group);
      }
    } catch (e) {
      fail(String(e));
    } finally {
      await refresh();
    }
  }

  /** Reports a failed operation without disturbing the list behind it. */
  function fail(message: string) {
    setNotice({ text: message, kind: 'error' });
  }

  /** Same place, for something that went well enough but is worth saying. */
  function say(message: string) {
    setNotice({ text: message, kind: 'info' });
  }

  return {
    mode, setMode, listing, style, local, remote, notice, dismissNotice: () => setNotice(null),
    sid, serverId, serverName, disconnected,
    connectingId, connectError, setConnectError, connectServer, connectLogs,
    navigate: (path: string) => (mode === 'local' ? navigateLocal(path) : navigateRemote(path)),
    refresh, goLocal, connect, disconnect, reconnect, navigateRemote,
    newFolder, rename, removeMany, setPerms, moveInto, open, fail, say, requireSid,
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
  const { servers, sftpRequest, clearSftpRequest } = useAppStore();

  // The left pane starts on the local disk, the right on the host list. That
  // and the eager home fetch below are the only asymmetry between them.
  const left = usePane('local');
  const right = usePane('picking');

  // A path clicked in a terminal. The pane already on that host takes it,
  // else the right one connects there first. A path that is not a
  // directory shows its parent; `~` is the home directory.
  const panesRef = useRef({ left, right });
  panesRef.current = { left, right };
  useEffect(() => {
    if (!sftpRequest) return;
    const server = servers.find((s) => s.id === sftpRequest.serverId);
    if (!server) { clearSftpRequest(); return; }
    const { left, right } = panesRef.current;
    const pane = left.serverId === server.id && left.sid ? left : right;
    let cancelled = false;
    (async () => {
      const sid = await pane.connect(server);
      if (!sid || cancelled) return;
      let path = sftpRequest.path;
      if (path === '~' || path.startsWith('~/')) {
        const home = await ipc.sftpGetHome(sid).catch(() => null);
        if (!home) return;
        path = home + path.slice(1);
      }
      // A file, or a path that is not there: land in its parent instead.
      const isDir = await ipc.sftpListRemote(sid, path).then(() => true, () => false);
      const target = isDir ? path : (remoteStyle.parent(path) ?? '/');
      if (!cancelled) await pane.navigateRemote(target, sid);
    })().finally(() => { if (!cancelled) clearSftpRequest(); });
    return () => { cancelled = true; };
  // The panes are read through the ref on purpose: a request is one event.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sftpRequest]);

  const [dropTarget, setDropTarget] = useState<'left' | 'right' | null>(null);
  const [transferring, setTransferring] = useState(false);
  const [transferTarget, setTransferTarget] = useState<'left' | 'right' | null>(null);
  const [progress, setProgress] = useState<
    (TransferProgress & { startTime: number; at: number }) | null
  >(null);
  // The transfer stops at the next chunk boundary, not on the click, so the
  // button says so rather than looking like it did nothing.
  const [cancelling, setCancelling] = useState(false);

  /**
   * Drops from outside the app. The webview reports these itself, with real
   * filesystem paths, which an HTML5 drop event never carries. The event is
   * window-wide, so the pane under the cursor is found from the position.
   *
   * Linux only, by configuration rather than by code: tauri.linux.conf.json
   * enables the webview's drag and drop, and tauri.conf.json leaves it off
   * because on Windows enabling it disables HTML5 drag and drop, which is
   * what moves files between the two panes. On Windows this listener is
   * registered and never fires.
   */
  useEffect(() => {
    // The type says physical; the number is not. On WebKitGTK the position
    // comes from GTK's drag_motion, which reports logical widget coordinates,
    // and wry 0.55 passes them through unscaled (webkitgtk/drag_drop.rs:96).
    // Dividing by devicePixelRatio, as the type invites, halved x on a HiDPI
    // display and put every drop on the left pane. This listener only ever
    // fires on Linux, so the GTK behaviour is the only one that matters.
    const paneAt = (position: { x: number; y: number }): 'left' | 'right' | null => {
      const el = document.elementFromPoint(position.x, position.y);
      const side = el?.closest<HTMLElement>('[data-side]')?.dataset.side;
      return side === 'left' || side === 'right' ? side : null;
    };
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      const p = event.payload;
      if (p.type === 'enter' || p.type === 'over') {
        setDropTarget(paneAt(p.position));
      } else if (p.type === 'leave') {
        setDropTarget(null);
      } else if (p.type === 'drop') {
        const target = paneAt(p.position);
        setDropTarget(null);
        if (target && p.paths.length > 0) void externalDropRef.current(target, p.paths);
      }
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  useEffect(() => {
    const unlisten = listen<TransferProgress>('sftp-progress', (e) => {
      setProgress((prev) => ({
        ...e.payload,
        startTime: prev?.startTime ?? Date.now(),
        at: Date.now(),
      }));
    });
    return () => { unlisten.then((f) => f()); };
  }, []);

  /**
   * Re-renders the progress bar once a second while a transfer is running.
   *
   * Speed and ETA are worked out from the last event during render, so when
   * the events stop the bar keeps showing whatever it last computed. Nothing
   * re-rendered, so a transfer whose server had gone displayed a healthy rate
   * and a falling ETA that never fell. The tick is what lets the bar notice
   * its own silence.
   */
  const [, setNow] = useState(0);
  const transferInFlight = progress !== null;
  useEffect(() => {
    if (!transferInFlight) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [transferInFlight]);

  // Mount only, and `left` cannot be named: the pane hook returns a fresh
  // object every render, so depending on it would put the pane back to its
  // local root on each one.
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
    if (s.skipped_existing > 0) {
      const n = s.skipped_existing;
      parts.push(`Skipped ${n} that already existed.`);
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
  async function handleDrop(target: 'left' | 'right', batch: FileEntry[]) {
    const dst = target === 'left' ? left : right;
    const src = target === 'left' ? right : left;
    if (!canMove(src, dst)) return;

    const run = (entry: FileEntry, conflict: Conflict): Promise<TransferSummary> => {
      if (src.mode === 'local') {
        return ipc.sftpUpload(dst.requireSid(), entry.path, dst.listing.path, conflict);
      }
      if (dst.mode === 'local') {
        return ipc.sftpDownload(src.requireSid(), entry.path, dst.listing.path, conflict);
      }
      return ipc.sftpCopyRemoteToRemote(src.requireSid(), entry.path, dst.requireSid(), dst.listing.path, conflict);
    };
    const check = (entry: FileEntry) => {
      if (src.mode === 'local') return ipc.sftpConflicts('upload', null, entry.path, dst.requireSid(), dst.listing.path);
      if (dst.mode === 'local') return ipc.sftpConflicts('download', src.requireSid(), entry.path, null, dst.listing.path);
      return ipc.sftpConflicts('copy', src.requireSid(), entry.path, dst.requireSid(), dst.listing.path);
    };

    await runBatch(target, batch, run, check, (entry) => entry.name);
  }

  /**
   * Files dragged in from the desktop, which arrive as paths rather than as
   * entries from the other pane. Only a connected remote pane can take them:
   * the local pane is the desktop, and copying a file to where it already is
   * is not a thing this does.
   */
  async function handleExternalDrop(target: 'left' | 'right', paths: string[]) {
    const dst = target === 'left' ? left : right;
    if (dst.mode !== 'connected' || transferring) return;
    const sid = dst.requireSid();
    await runBatch(
      target,
      paths,
      (path, conflict) => ipc.sftpUpload(sid, path, dst.listing.path, conflict),
      (path) => ipc.sftpConflicts('upload', null, path, sid, dst.listing.path),
      (path) => localStyle().basename(path),
    );
  }

  /**
   * Puts the question up and waits for the answer. Held as a resolver in
   * state because runBatch is a loop that has to pause on it; the dialog
   * itself is plain JSX rendered while the state is set.
   */
  const [conflictPrompt, setConflictPrompt] = useState<{ prompt: ConflictPrompt; resolve: (a: ConflictAnswer | null) => void } | null>(null);
  function askConflict(prompt: ConflictPrompt): Promise<ConflictAnswer | null> {
    return new Promise((resolve) => setConflictPrompt({ prompt, resolve }));
  }

  // The drag-drop event fires from a listener registered once, so it reads
  // the handler through a ref rather than closing over the first render's
  // panes, which would upload into whatever directory was open at startup.
  const externalDropRef = useRef(handleExternalDrop);
  externalDropRef.current = handleExternalDrop;

  async function runBatch<T>(
    target: 'left' | 'right',
    batch: T[],
    run: (item: T, conflict: Conflict) => Promise<TransferSummary>,
    check: (item: T) => Promise<string[]>,
    nameOf: (item: T) => string,
  ) {
    const dst = target === 'left' ? left : right;
    setTransferring(true);
    setTransferTarget(target);
    setDropTarget(null);
    try {
      // One after another rather than all at once: the backend runs one
      // transfer at a time per session, the progress bar describes one, and
      // the cancel flag stops the one in flight. A cancel ends the batch too,
      // since carrying on with the next file is not what "stop" means.
      const summary: TransferSummary = { files: 0, directories: 0, skipped_symlinks: 0, skipped_existing: 0, cancelled: false };
      // Decided once for the whole batch when the user ticks "for the
      // rest"; until then every item that collides asks on its own.
      let forAll: Conflict | null = null;
      for (const [i, item] of batch.entries()) {
        let conflict: Conflict = forAll ?? 'overwrite';
        if (forAll === null) {
          const files = await check(item);
          if (files.length > 0) {
            const answer = await askConflict({ name: nameOf(item), files, more: i < batch.length - 1 });
            if (answer === null) {
              summary.cancelled = true;
              break;
            }
            conflict = answer.choice;
            if (answer.applyToAll) forAll = answer.choice;
          }
        }
        const one = await run(item, conflict);
        summary.files += one.files;
        summary.directories += one.directories;
        summary.skipped_symlinks += one.skipped_symlinks;
        summary.skipped_existing += one.skipped_existing;
        if (one.cancelled) {
          summary.cancelled = true;
          break;
        }
      }
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
        pathStyle={pane.style}
        title={pane.mode === 'local' ? 'Local' : pane.serverName}
        icon={pane.mode === 'local' ? LOCAL_ICON : REMOTE_ICON}
        path={pane.listing.path}
        home={pane.listing.home}
        entries={pane.listing.entries}
        loading={pane.listing.loading}
        error={pane.listing.error}
        notice={pane.notice}
        onDismissNotice={pane.dismissNotice}
        onNavigate={pane.navigate}
        onRefresh={pane.refresh}
        onNewFolder={pane.newFolder}
        canCopyToTarget={canMove(pane, other)}
        onCopyToTarget={(batch) => handleDrop(side === 'left' ? 'right' : 'left', batch)}
        onRename={pane.rename}
        onDelete={pane.removeMany}
        onSetMode={pane.setPerms}
        onMove={pane.moveInto}
        onOpen={pane.open}
        onLocalBtn={() => pane.setMode('idle')}
        extraActions={closeConnectionActions(
          pane.mode === 'local' ? () => pane.setMode('idle') : pane.disconnect,
        )}
        side={side}
        isDropTarget={dropTarget === side && !transferring}
        transferring={transferring && transferTarget === side}
        onDragEnter={() => setDropTarget(side)}
        onDragLeave={() => setDropTarget((p) => (p === side ? null : p))}
        onFileDrop={(batch) => handleDrop(side, batch)}
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
      {conflictPrompt && (
        <ConflictDialog
          prompt={conflictPrompt.prompt}
          onAnswer={(a) => { conflictPrompt.resolve(a); setConflictPrompt(null); }}
        />
      )}
      <div className="sftp-panels-row">
        <div className="sftp-file-panel" data-side="left">{renderPane(left, right, 'left')}</div>
        <div className="sftp-divider" />
        <div className="sftp-file-panel sftp-remote-panel" data-side="right">{renderPane(right, left, 'right')}</div>
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
        // Reporting silence rather than a stale rate. The backend gives a
        // stalled transfer a minute before it calls the connection dead, and
        // saying nothing for that minute is what made a dead transfer look
        // like a working one.
        //
        // Ten seconds rather than five: one 128 KB chunk takes 6.4s at
        // 20 KB/s, so a shorter window would call a slow link stalled. At this
        // one the claim only goes wrong below about 13 KB/s, and even then it
        // is describing something true.
        const silentFor = Math.round((Date.now() - progress.at) / 1000);
        const stalled = silentFor >= 10;
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
              <span className="sftp-progress-stat">
                {stalled
                  ? `${pct}% · stalled for ${silentFor}s`
                  : `${pct}% · ${speedStr}${speedStr ? ' · ' : ''}ETA ${eta}`}
              </span>
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
