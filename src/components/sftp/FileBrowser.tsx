import { useState, useEffect, useRef } from 'react';
import type { FileEntry, SftpBookmark } from '../../types';
import SftpDialog from '../shared/SftpDialog';
import { useDismissOnOutside } from '../shared/useDismissOnOutside';
import { useHint } from '../shared/useHint';
import { useDragResize } from '../shared/useDragResize';
import { resolveTyped, type PathStyle } from '../../paths';
import { HEADERS, formatDate, formatSize, visibleEntries, type SortCol } from '../../fileList';
import { fileDragPayload, readDragPayload } from '../../dragPayload';
import PermissionsDialog, { type OwnerChange } from './PermissionsDialog';
import BookmarksMenu from './BookmarksMenu';
import FileContextMenu from './FileContextMenu';
import { FileIcon, FolderIcon } from './icons';
import { batchFor, nextCursor, rangePaths, type Notice } from './panes';
import { isAndroid } from '../../platform';

const DEFAULT_COL_WIDTHS = [38, 22, 10, 14, 16];

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
  onDragEnter?: () => void;
  onDragLeave?: () => void;
  onFileDrop?: (entries: FileEntry[]) => void;
  onReconnect?: () => void;
  /** This pane's saved directories, already narrowed to it. */
  bookmarks?: SftpBookmark[];
  /** Whether the directory on screen is one of them. */
  bookmarked?: boolean;
  /** Saves or unsaves the directory on screen. */
  onToggleBookmark?: () => void;
  onDeleteBookmark?: (id: string) => void;
  /** Saves a directory the user right-clicked rather than the open one. */
  onBookmarkPath?: (path: string) => void;
  /** Tars a remote directory on the server and unpacks it on the other side. */
  onCompressedCopy?: (entry: FileEntry) => void;
  /** Compares a directory with the one open in the other pane. */
  onCompare?: (entry: FileEntry) => void;
  /** How to take this pane's paths apart: POSIX remotely, native locally. */
  pathStyle: PathStyle;
}

/** One pane's file list: its header, path bar, filter, table and the dialogs they open. */
export default function FileBrowser({ title, icon, path, home, entries, loading, error, notice, onDismissNotice, onNavigate,
  onRefresh, onNewFolder, extraActions, onLocalBtn,
  canCopyToTarget, onCopyToTarget, onRename, onDelete, onSetMode, onOpen, onMove,
  bookmarks, bookmarked, onToggleBookmark, onDeleteBookmark, onBookmarkPath, onCompressedCopy, onCompare,
  side, isDropTarget, onDragEnter: onDragEnterCb, onDragLeave: onDragLeaveCb, onFileDrop, onReconnect,
  pathStyle,
}: FileBrowserProps) {
  const hint = useHint();
  const startDrag = useDragResize();
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
    const startW = colWidths[colIdx];
    const startNextW = colWidths[colIdx + 1] ?? 0;
    startDrag(e, tableRef.current?.getBoundingClientRect().width ?? 800, (delta) => {
      setColWidths((prev) => {
        const next = [...prev];
        // Zero-sum against the neighbour, and neither of the pair narrower
        // than its header.
        next[colIdx] = Math.max(6, startW + delta);
        if (colIdx + 1 < next.length) next[colIdx + 1] = Math.max(6, startNextW - delta);
        return next;
      });
    });
  }

  /**
   * The rows in the order they are drawn: `..` first, then the rest sorted and
   * with hidden files left out unless asked for. Row indexes mean this order,
   * so anything that turns an index back into entries has to use it too. The
   * shift range used to slice `entries`, the unsorted prop, so a range over
   * rows 3 to 6 selected whichever files happened to sit at 3 to 6 in
   * directory order.
   */
  const visible = visibleEntries(entries, {
    sortCol,
    sortAsc,
    dirsOnTop,
    showHidden,
    filter: filter ?? '',
  });

  /** The selection, or `entry` alone when it is not part of it. */
  const batch = (entry: FileEntry) => batchFor(visible, selectedPaths, entry);

  function handleRowClick(e: React.MouseEvent, entry: FileEntry, idx: number) {
    if (entry.name === '..') return;
    cursorRef.current = idx;
    wrapRef.current?.focus();
    if (e.shiftKey && lastClickIdxRef.current >= 0) {
      const range = rangePaths(visible, lastClickIdxRef.current, idx);
      setSelectedPaths(prev => {
        const next = (e.ctrlKey || e.metaKey) ? new Set(prev) : new Set<string>();
        range.forEach(p => next.add(p));
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
    setSelectedPaths(new Set(rangePaths(visible, anchor, idx)));
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
      const next = nextCursor(rows, cursorRef.current, e.key === 'ArrowDown' ? 1 : -1);
      if (next === null) return;
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

  function handleDragStart(e: React.DragEvent, entry: FileEntry) {
    if (!side) return;
    e.dataTransfer.setData('text/plain', fileDragPayload(side, batch(entry)));
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

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    dragCountRef.current = 0;
    onDragLeaveCb?.();
    if (!onFileDrop) return;
    const payload = readDragPayload(e.dataTransfer.getData('text/plain'));
    // A drop from this pane onto itself is not a transfer; the row handler
    // above deals with those as moves.
    if (payload && payload.fromSide !== side) onFileDrop(payload.dropped);
  }

  /** A drop on a directory row: a move when it came from this pane. */
  function handleRowDrop(e: React.DragEvent, dir: FileEntry) {
    const payload = readDragPayload(e.dataTransfer.getData('text/plain'));
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
          {onToggleBookmark && (
            <BookmarksMenu
              bookmarks={bookmarks ?? []}
              bookmarked={!!bookmarked}
              onToggle={onToggleBookmark}
              onNavigate={onNavigate}
              onDelete={onDeleteBookmark}
            />
          )}
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
          <button className="sftp-filter-close" onClick={closeFilter} title={hint('Clear filter')} aria-label="Clear filter">✕</button>
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
                // Not on Android, where a long press would start a drag rather
                // than open the menu, and the other pane is never in view.
                draggable={!isAndroid && entry.name !== '..'}
                // A tap opens a folder on a phone, which has no double-click.
                onClick={(e) => (isAndroid && entry.is_dir ? onNavigate(entry.path) : handleRowClick(e, entry, idx))}
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
                      <span className="sftp-link-tag" title={hint("A symbolic link. Size and type are its target's.")}>
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
      </div>

      {contextMenu && (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          entry={contextMenu.entry}
          onClose={() => setContextMenu(null)}
          onOpen={onOpen}
          onCopyToTarget={canCopyToTarget ? (entry) => onCopyToTarget?.(batch(entry)) : undefined}
          onCompressedCopy={onCompressedCopy}
          onCompare={onCompare}
          onBookmarkPath={onBookmarkPath}
          onRename={handleRenameClick}
          onPermissions={onSetMode ? (entry) => setPermEntries(batch(entry)) : undefined}
          onDelete={(entry) => setConfirmDelete(batch(entry))}
          onRefresh={onRefresh}
          onNewFolder={handleNewFolderClick}
          showHidden={showHidden}
          onToggleHidden={() => setShowHidden(h => !h)}
          dirsOnTop={dirsOnTop}
          onToggleDirsOnTop={() => setDirsOnTop(v => !v)}
        />
      )}

      {notice && (
        <div className={`sftp-notice${notice.kind === 'info' ? ' sftp-notice-info' : ''}`}>
          <span className="sftp-notice-text">{notice.text}</span>
          <button
            className="sftp-notice-close"
            onClick={onDismissNotice}
            aria-label="Dismiss"
            title={hint('Dismiss')}
          >
            ✕
          </button>
        </div>
      )}

      {confirmDelete && (
        <SftpDialog
          title={confirmDelete.length === 1
            ? `Delete "${confirmDelete[0].name}"?`
            : `Delete ${confirmDelete.length} items?`}
          onEscape={() => setConfirmDelete(null)}
        >
          <p className="sftp-confirm-sub">This cannot be undone.</p>
          <div className="sftp-confirm-actions">
            {/* Focused so a delete is never one stray Return away, and so
                Escape reaches the dialog that is listening for it. */}
            <button className="sftp-action-btn" onClick={() => setConfirmDelete(null)} autoFocus>Cancel</button>
            <button className="sftp-confirm-delete-btn" onClick={() => { onDelete?.(confirmDelete); setConfirmDelete(null); }}>Delete</button>
          </div>
        </SftpDialog>
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
