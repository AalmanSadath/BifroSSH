import type { FileEntry } from '../../types';
import ContextMenu from '../shared/ContextMenu';
import { useHint } from '../shared/useHint';

interface FileContextMenuProps {
  x: number;
  y: number;
  /** The row right-clicked, or null for the empty space below the rows. */
  entry: FileEntry | null;
  onClose: () => void;

  // On a row. Each is offered only when the pane passed it.
  onOpen?: (entry: FileEntry) => void;
  /** Absent when the other pane is not somewhere a copy can go. */
  onCopyToTarget?: (entry: FileEntry) => void;
  onCompressedCopy?: (entry: FileEntry) => void;
  onCompare?: (entry: FileEntry) => void;
  onBookmarkPath?: (path: string) => void;
  onRename: (entry: FileEntry) => void;
  onPermissions?: (entry: FileEntry) => void;
  onDelete: (entry: FileEntry) => void;

  // On the space below.
  onRefresh?: () => void;
  onNewFolder: () => void;
  showHidden: boolean;
  onToggleHidden: () => void;
  dirsOnTop: boolean;
  onToggleDirsOnTop: () => void;
}

/** The file list's right-click menu: one for a row, another for the list itself. */
export default function FileContextMenu(p: FileContextMenuProps) {
  const hint = useHint();
  // Every item closes the menu after doing its thing.
  const then = (action: () => void) => () => { action(); p.onClose(); };
  const entry = p.entry;
  const realDir = !!entry && entry.is_dir && entry.name !== '..';

  return (
    <ContextMenu className="sftp-context-menu" x={p.x} y={p.y} onClose={p.onClose}>
      {entry ? (
        <>
          {!entry.is_dir && p.onOpen && (
            <button className="menu-item" onClick={then(() => p.onOpen!(entry))}>
              Open
            </button>
          )}
          {p.onCopyToTarget && (
            <button className="menu-item" onClick={then(() => p.onCopyToTarget!(entry))}>
              Copy to Target
            </button>
          )}
          {realDir && p.onCompressedCopy && (
            <button
              className="menu-item"
              title={hint('Runs tar on the server and unpacks the stream here. Much quicker for a folder of many small files.')}
              onClick={then(() => p.onCompressedCopy!(entry))}
            >
              Copy to Target compressed
            </button>
          )}
          {realDir && p.onCompare && (
            <button
              className="menu-item"
              title={hint('Reads both folders and reports what differs. Nothing is copied.')}
              onClick={then(() => p.onCompare!(entry))}
            >
              Compare with the other pane
            </button>
          )}
          {realDir && p.onBookmarkPath && (
            <button className="menu-item" onClick={then(() => p.onBookmarkPath!(entry.path))}>
              Bookmark this folder
            </button>
          )}
          <button className="menu-item" onClick={then(() => p.onRename(entry))}>
            Rename
          </button>
          {entry.mode !== null && p.onPermissions && (
            <button className="menu-item" onClick={then(() => p.onPermissions!(entry))}>
              Permissions…
            </button>
          )}
          <div className="menu-divider" />
          <button className="menu-item menu-item-danger" onClick={then(() => p.onDelete(entry))}>
            Delete
          </button>
        </>
      ) : (
        <>
          <button className="menu-item" onClick={then(() => p.onRefresh?.())}>
            Refresh
          </button>
          <button className="menu-item" onClick={then(p.onNewFolder)}>
            New Folder
          </button>
          <button className="menu-item" onClick={then(p.onToggleHidden)}>
            {p.showHidden ? 'Hide Hidden Files' : 'Show Hidden Files'}
          </button>
          <button className="menu-item" onClick={then(p.onToggleDirsOnTop)}>
            {p.dirsOnTop ? 'Folders on Top ✓' : 'Folders on Top'}
          </button>
        </>
      )}
    </ContextMenu>
  );
}
