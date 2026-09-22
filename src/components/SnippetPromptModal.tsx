import { useState } from 'react';
import Modal from './shared/Modal';
import { placeholders } from '../snippets';

interface Props {
  /** What is being filled in: the codeprint's name. */
  title: string;
  command: string;
  onSubmit: (values: Record<string, string>) => void;
  onCancel: () => void;
}

/**
 * One box per placeholder in a codeprint, asked just before it is sent.
 * Enter submits from any box; the defaults are already in the boxes, so
 * a codeprint whose defaults all suit is Enter and done.
 */
export default function SnippetPromptModal({ title, command, onSubmit, onCancel }: Props) {
  const fields = placeholders(command);
  const [values, setValues] = useState<Record<string, string>>(
    () => Object.fromEntries(fields.map((f) => [f.name, f.fallback ?? ''])),
  );

  return (
    <Modal
      title={`Fill in ${title}`}
      subtitle={<code className="snippet-preview">{command}</code>}
      className="snippet-modal"
      onClose={onCancel}
      onSubmit={(e) => { e.preventDefault(); onSubmit(values); }}
    >
      <div onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}>
        {fields.map((f, i) => (
          <div className="form-group" key={f.name}>
            <label htmlFor={`snippet-${f.name}`}>{f.name}</label>
            <input
              id={`snippet-${f.name}`}
              value={values[f.name] ?? ''}
              onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}
              autoFocus={i === 0}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        ))}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn-secondary btn-sm" onClick={onCancel}>Cancel</button>
        <button type="submit" className="btn-primary btn-sm">Send</button>
      </div>
    </Modal>
  );
}
