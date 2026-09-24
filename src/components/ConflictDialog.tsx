import { useState } from 'react';
import type { Conflict } from '../types';
import SftpDialog from './shared/SftpDialog';

/** What the user decided, and whether it holds for the rest of the batch. */
export interface ConflictAnswer {
  choice: Conflict;
  applyToAll: boolean;
}

/** One question: an item about to land on files that are already there. */
export interface ConflictPrompt {
  /** The dropped item's name. */
  name: string;
  /** The colliding files, relative to the item; one entry equal to `name` for a file. */
  files: string[];
  /** Whether more items follow in the batch, which is when "for the rest" means anything. */
  more: boolean;
}

/** How many colliding names are listed before "and N more". */
const SHOWN = 3;

interface Props {
  prompt: ConflictPrompt;
  onAnswer: (answer: ConflictAnswer | null) => void;
}

/**
 * Asked once per dropped item that would write over something, before the
 * item is transferred. The shape of the delete confirmation: an overlay
 * over the panel, Escape cancels, which here means the whole batch stops.
 */
export default function ConflictDialog({ prompt, onAnswer }: Props) {
  const [applyToAll, setApplyToAll] = useState(false);
  const single = prompt.files.length === 1 && prompt.files[0] === prompt.name;
  const answer = (choice: Conflict) => onAnswer({ choice, applyToAll });

  const title = single
    ? `"${prompt.name}" already exists`
    : `${prompt.files.length} ${prompt.files.length === 1 ? 'file' : 'files'} in "${prompt.name}" already exist`;

  return (
    <SftpDialog title={title} onEscape={() => onAnswer(null)} className="sftp-conflict-dialog">
      {!single && (
        <ul className="sftp-conflict-list">
          {prompt.files.slice(0, SHOWN).map((f) => <li key={f}>{f}</li>)}
          {prompt.files.length > SHOWN && <li>and {prompt.files.length - SHOWN} more</li>}
        </ul>
      )}
      <p className="sftp-confirm-sub">
        Overwrite replaces {single ? 'it' : 'them'}. Keep both writes the new {single ? 'one' : 'ones'} under a numbered name.
      </p>
      {prompt.more && (
        <label className="checkbox-row sftp-conflict-all">
          <input type="checkbox" checked={applyToAll} onChange={(e) => setApplyToAll(e.target.checked)} />
          <span>Do this for the rest</span>
        </label>
      )}
      <div className="sftp-confirm-actions">
        <button className="sftp-action-btn" onClick={() => onAnswer(null)} autoFocus>Cancel</button>
        <button className="sftp-action-btn" onClick={() => answer('skip')}>Skip</button>
        <button className="sftp-action-btn" onClick={() => answer('keep_both')}>Keep both</button>
        <button className="sftp-action-btn sftp-perms-apply-btn" onClick={() => answer('overwrite')}>Overwrite</button>
      </div>
    </SftpDialog>
  );
}
