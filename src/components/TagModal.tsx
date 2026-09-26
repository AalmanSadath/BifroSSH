import { useRef, useState } from 'react';
import Modal from './shared/Modal';
import { PortalMenu, anchorBelow, type AnchorRect } from './shared/PortalDropdown';
import { MAX_TAG_LEN } from '../hosts';
import { Picker } from './settings/Picker';

interface Props {
  /** Adding a tag, or taking one off. */
  mode: 'add' | 'remove';
  /** How many hosts it is for, for the title. */
  count: number;
  /**
   * The tags offered as the field is typed in: every tag in use when adding,
   * and only those the hosts carry when removing.
   */
  tags: string[];
  /** When removing, how many of the hosts carry each tag, for its label. */
  counts?: Record<string, number>;
  onDone: (tag: string) => void;
  onClose: () => void;
}

/** Asks which tag to put on some hosts, or take off them. */
export default function TagModal({ mode, count, tags, counts, onDone, onClose }: Props) {
  // Removing picks from the tags the hosts have; there is nothing else to take off.
  const [tag, setTag] = useState(mode === 'remove' ? (tags[0] ?? '') : '');
  const [rect, setRect] = useState<AnchorRect | null>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const typed = tag.trim().toLowerCase();
  const suggestions = tags.filter((t) => t.toLowerCase().includes(typed) && t.toLowerCase() !== typed);
  const hosts = `${count} ${count === 1 ? 'host' : 'hosts'}`;

  return (
    <Modal
      title={mode === 'add' ? `Tag ${hosts}` : `Remove a tag from ${hosts}`}
      onClose={onClose}
      onSubmit={(e) => {
        e.preventDefault();
        if (tag.trim() !== '') onDone(tag.trim());
      }}
    >
      {mode === 'remove' ? (
        <div className="form-group">
          <label>Tag</label>
          <Picker
            value={tag}
            options={tags.map((t) => ({
              value: t,
              label: count > 1 && counts ? `${t} (on ${counts[t.toLowerCase()] ?? 0} of ${count})` : t,
            }))}
            onChange={setTag}
          />
        </div>
      ) : (
        <div className="form-group" ref={fieldRef}>
          <label>Tag</label>
          <input
            autoFocus
            value={tag}
            maxLength={MAX_TAG_LEN}
            onChange={(e) => setTag(e.target.value.replace(/,/g, ''))}
            onFocus={() => setRect(anchorBelow(fieldRef.current?.querySelector('input')))}
            onBlur={() => setTimeout(() => setRect(null), 150)}
            placeholder="A new or existing tag"
            autoComplete="off"
            spellCheck={false}
          />
          {rect && suggestions.length > 0 && (
            <PortalMenu rect={rect} maxHeight={220}>
              {suggestions.map((t) => (
                <button
                  key={t}
                  type="button"
                  className="picker-item"
                  onMouseDown={(e) => { e.preventDefault(); setTag(t); setRect(null); }}
                >
                  {t}
                </button>
              ))}
            </PortalMenu>
          )}
        </div>
      )}
      <div className="modal-actions">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn-primary" disabled={tag.trim() === ''}>
          {mode === 'add' ? 'Add tag' : 'Remove tag'}
        </button>
      </div>
    </Modal>
  );
}
