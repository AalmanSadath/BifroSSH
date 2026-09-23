import { diffGroups, differenceCount, isIdentical } from '../compare';
import type { TreeDiff } from '../types';

interface Props {
  /** What is being compared, as the two paths read on screen. */
  left: string;
  right: string;
  /** Null while the comparison is still running. */
  diff: TreeDiff | null;
  /** Stops a comparison that is still running. */
  onCancel: () => void;
  onClose: () => void;
}

/**
 * What a folder comparison found.
 *
 * The shape of the conflict dialog: an overlay over the panel, Escape
 * closes. Taller and wider than that one, which is sized for three names
 * and a question; this is a list the user reads.
 */
export default function CompareDialog({ left, right, diff, onCancel, onClose }: Props) {
  const groups = diff === null ? [] : diffGroups(diff);

  return (
    <div
      className="sftp-confirm-overlay"
      onKeyDown={(e) => {
        // Escape stops a comparison still running, and dismisses a finished
        // one; both are "I am done with this dialog".
        if (e.key === 'Escape') { if (diff === null) onCancel(); else onClose(); }
      }}
    >
      <div className="sftp-confirm-dialog sftp-compare-dialog">
        <p className="sftp-confirm-title">
          {diff === null ? 'Comparing…' : isIdentical(diff) ? 'No differences' : `${differenceCount(diff)} differences`}
        </p>
        <p className="sftp-confirm-sub sftp-compare-paths">
          <span>{left}</span>
          <span>{right}</span>
        </p>

        {diff === null ? (
          <p className="sftp-confirm-sub">
            Files of different size are settled without reading them; the rest are read and
            hashed on both sides.
          </p>
        ) : (
          <>
            <p className="sftp-confirm-sub">
              {diff.same} the same, {diff.hashed} read and hashed.
              {diff.cancelled && ' Stopped before the end, so this is partial.'}
            </p>
            {groups.length > 0 && (
              <div className="sftp-compare-groups">
                {groups.map((group) => (
                  <div key={group.title} className="sftp-compare-group">
                    <div className="sftp-compare-group-title">
                      {group.title} ({group.files.length})
                    </div>
                    <ul className="sftp-conflict-list sftp-compare-list">
                      {group.files.map((file) => <li key={file}>{file === '' ? '(the file itself)' : file}</li>)}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        <div className="sftp-confirm-actions">
          {diff === null ? (
            <button className="sftp-action-btn" onClick={onCancel} autoFocus>Stop</button>
          ) : (
            <button className="sftp-action-btn sftp-perms-apply-btn" onClick={onClose} autoFocus>Close</button>
          )}
        </div>
      </div>
    </div>
  );
}
