import Modal from './shared/Modal';
import { tabLabel } from '../tabName';
import type { SessionTab } from '../types';

/** Lines of the shared text shown before it is cut short. */
const PREVIEW_LINES = 5;

interface Props {
  text: string;
  /** Connected terminal tabs, in strip order. */
  tabs: SessionTab[];
  onPick: (tabId: string) => void;
  onCancel: () => void;
}

/**
 * Text shared from another Android app, and which terminal it goes to.
 *
 * Always asked rather than sent to the tab in front: text arriving from
 * outside should not land in a shell without a look at it first. Pasted, not
 * run: nothing presses Enter for it.
 */
export default function ShareToTerminalModal({ text, tabs, onPick, onCancel }: Props) {
  const lines = text.split('\n');
  const preview = lines.slice(0, PREVIEW_LINES).join('\n') + (lines.length > PREVIEW_LINES ? '\n…' : '');
  return (
    <Modal
      title="Paste shared text"
      subtitle={<code className="snippet-preview">{preview}</code>}
      className="snippet-modal"
      onClose={onCancel}
    >
      <p className="form-hint form-hint-flush">Into which terminal? It is pasted, not run.</p>
      <div className="share-tabs">
        {tabs.map((t) => (
          <button key={t.tab_id} type="button" className="menu-item" onClick={() => onPick(t.tab_id)}>
            {tabLabel(t)}
          </button>
        ))}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn-secondary btn-sm" onClick={onCancel}>Cancel</button>
      </div>
    </Modal>
  );
}
