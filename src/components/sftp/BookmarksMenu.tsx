import { useRef, useState } from 'react';
import type { SftpBookmark } from '../../types';
import { useDismissOnOutside } from '../shared/useDismissOnOutside';
import { useHint } from '../shared/useHint';

interface BookmarksMenuProps {
  /** This pane's saved directories, already narrowed to it. */
  bookmarks: SftpBookmark[];
  /** Whether the directory on screen is one of them. */
  bookmarked: boolean;
  /** Saves or unsaves the directory on screen. */
  onToggle: () => void;
  onNavigate: (path: string) => void;
  onDelete?: (id: string) => void;
}

/**
 * Saved directories for one pane: the star saves or unsaves the one on
 * screen, the caret lists the rest.
 */
export default function BookmarksMenu({ bookmarks, bookmarked, onToggle, onNavigate, onDelete }: BookmarksMenuProps) {
  const hint = useHint();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useDismissOnOutside(ref, open, () => setOpen(false));

  return (
    <>
      <button
        className={`sftp-action-btn sftp-star-btn${bookmarked ? ' sftp-star-on' : ''}`}
        onClick={onToggle}
        title={hint(bookmarked ? 'Remove this folder from bookmarks' : 'Bookmark this folder')}
      >
        {bookmarked ? '★' : '☆'}
      </button>
      <div className="sftp-dropdown-wrap" ref={ref}>
        <button
          className="sftp-action-btn"
          onClick={() => setOpen((o) => !o)}
          title={hint('Saved folders')}
        >
          Bookmarks ▾
        </button>
        {open && (
          <div className="sftp-dropdown-menu">
            {bookmarks.length === 0 && (
              <div className="sftp-bookmark-empty">No bookmarks for this side yet.</div>
            )}
            {bookmarks.map((b) => (
              <div className="sftp-bookmark-row" key={b.id}>
                <button
                  className="menu-item sftp-bookmark-go"
                  title={b.path}
                  onClick={() => { setOpen(false); onNavigate(b.path); }}
                >
                  <span className="sftp-bookmark-label">{b.label}</span>
                  <span className="sftp-bookmark-path">{b.path}</span>
                </button>
                <button
                  className="sftp-bookmark-del"
                  title={hint('Remove')}
                  onClick={() => onDelete?.(b.id)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
