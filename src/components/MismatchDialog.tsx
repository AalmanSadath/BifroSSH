import { countOf, shownPath, type Mismatch } from '../mismatches';
import SftpDialog from './shared/SftpDialog';

/** How many names are listed before "and N more". */
const SHOWN = 6;

interface Props {
  mismatches: Mismatch[];
  onLeave: () => void;
  onCopyAgain: () => void;
}

/**
 * Shown once a batch has finished, naming the resumed files whose copy did
 * not match the original.
 *
 * Every resumed file is read back whole, because a resume joins two attempts
 * at a byte nobody watched. This is what happens when that check says no: the
 * files are left where they are and the user decides, rather than the app
 * quietly copying gigabytes a second time.
 */
export default function MismatchDialog({ mismatches, onLeave, onCopyAgain }: Props) {
  const names = mismatches.flatMap((m) => m.rels.map((rel) => shownPath(m, rel)));
  const count = countOf(mismatches);

  const title = count === 1
    ? '1 resumed file does not match the original'
    : `${count} resumed files do not match the original`;

  return (
    <SftpDialog title={title} onEscape={onLeave} className="sftp-conflict-dialog">
      <ul className="sftp-conflict-list">
        {names.slice(0, SHOWN).map((n) => <li key={n}>{n}</li>)}
        {names.length > SHOWN && <li>and {names.length - SHOWN} more</li>}
      </ul>
      <p className="sftp-confirm-sub">
        Each was continued from an unfinished copy and read back whole afterwards.
        Copy again sends {count === 1 ? 'it' : 'them'} from the start, over what is there.
      </p>
      <div className="sftp-confirm-actions">
        <button className="sftp-action-btn" onClick={onLeave} autoFocus>Leave</button>
        <button className="sftp-action-btn sftp-perms-apply-btn" onClick={onCopyAgain}>Copy again</button>
      </div>
    </SftpDialog>
  );
}
