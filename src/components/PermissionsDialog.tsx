import { useState } from 'react';
import type { FileEntry } from '../types';
import SftpDialog from './shared/SftpDialog';

/** An octal string typed by hand, or null when it names no valid mode. */
export function parseOctal(s: string): number | null {
  const t = s.trim();
  if (!/^[0-7]{1,4}$/.test(t)) return null;
  return parseInt(t, 8) & 0o7777;
}

/** Three digits, the width `644` and `1777` both fit without truncating. */
export function toOctal(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(3, '0');
}

const ROWS: { label: string; read: number; write: number; exec: number }[] = [
  { label: 'Owner', read: 0o400, write: 0o200, exec: 0o100 },
  { label: 'Group', read: 0o040, write: 0o020, exec: 0o010 },
  { label: 'Others', read: 0o004, write: 0o002, exec: 0o001 },
];

/** A chown asked for alongside the chmod; null when the boxes were left alone. */
export interface OwnerChange {
  user: string;
  group: string;
}

/**
 * The owner the boxes start from: the first entry's, split in two. Empty
 * where the listing had none to show, which is a Windows local pane.
 */
export function splitOwner(owner: string): OwnerChange {
  const cut = owner.indexOf(':');
  if (cut < 0) return { user: owner, group: '' };
  return { user: owner.slice(0, cut), group: owner.slice(cut + 1) };
}

/**
 * What to send for the owner boxes: null when both still read what they
 * started as, so an unchanged dialog does not chown at all. A box wiped
 * blank counts as unchanged too, since there is nothing to send.
 */
export function ownerChange(initial: OwnerChange, user: string, group: string): OwnerChange | null {
  const u = user.trim() || initial.user;
  const g = group.trim() || initial.group;
  if (u === initial.user && g === initial.group) return null;
  return { user: u, group: g };
}

interface Props {
  entries: FileEntry[];
  onApply: (mode: number, owner: OwnerChange | null) => void;
  onCancel: () => void;
}

/**
 * chmod for one entry or a selection, in the shape of the delete
 * confirmation this panel already shows: an overlay over the pane it was
 * opened from, not a separate window.
 *
 * With several entries selected the grid starts from the first one's mode
 * and the mode chosen is applied to all of them; nothing here assumes they
 * started alike.
 */
export default function PermissionsDialog({ entries, onApply, onCancel }: Props) {
  const [mode, setMode] = useState(entries[0]?.mode ?? 0o644);
  const [octalText, setOctalText] = useState(toOctal(entries[0]?.mode ?? 0o644));
  const [octalError, setOctalError] = useState(false);
  const initialOwner = splitOwner(entries[0]?.owner ?? '');
  const [user, setUser] = useState(initialOwner.user);
  const [group, setGroup] = useState(initialOwner.group);
  // No owner to show means no owner to set: a Windows local listing.
  const canChown = entries[0]?.owner !== '' && entries[0]?.owner !== undefined;

  function setBit(bit: number, on: boolean) {
    const next = on ? mode | bit : mode & ~bit;
    setMode(next);
    setOctalText(toOctal(next));
    setOctalError(false);
  }

  function editOctal(text: string) {
    setOctalText(text);
    const parsed = parseOctal(text);
    if (parsed === null) {
      setOctalError(true);
      return;
    }
    setOctalError(false);
    setMode(parsed);
  }

  const title = entries.length === 1
    ? `Permissions of "${entries[0].name}"`
    : `Permissions of ${entries.length} items`;

  return (
    <SftpDialog title={title} onEscape={onCancel} className="sftp-perms-dialog">

        <table className="sftp-perms-grid">
          <thead>
            <tr>
              <th />
              <th>Read</th>
              <th>Write</th>
              <th>Execute</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((row) => (
              <tr key={row.label}>
                <td>{row.label}</td>
                {[row.read, row.write, row.exec].map((bit) => (
                  <td key={bit}>
                    <input
                      type="checkbox"
                      checked={(mode & bit) !== 0}
                      onChange={(e) => setBit(bit, e.target.checked)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>

        <div className="sftp-perms-octal">
          <label htmlFor="sftp-perms-octal-input">Octal</label>
          <input
            id="sftp-perms-octal-input"
            className={octalError ? 'sftp-perms-octal-input-error' : undefined}
            value={octalText}
            onChange={(e) => editOctal(e.target.value)}
            maxLength={4}
            spellCheck={false}
            autoFocus
          />
        </div>

        {canChown && (
          <div className="sftp-perms-owner" title="Giving a file away usually needs root; changing its group to one you belong to does not.">
            <label htmlFor="sftp-perms-user-input">Owner</label>
            <input
              id="sftp-perms-user-input"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            <label htmlFor="sftp-perms-group-input">Group</label>
            <input
              id="sftp-perms-group-input"
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
          </div>
        )}

        <div className="sftp-confirm-actions">
          <button className="sftp-action-btn" onClick={onCancel}>Cancel</button>
          <button
            className="sftp-action-btn sftp-perms-apply-btn"
            disabled={octalError}
            onClick={() => onApply(mode, canChown ? ownerChange(initialOwner, user, group) : null)}
          >
            Apply
          </button>
      </div>
    </SftpDialog>
  );
}
