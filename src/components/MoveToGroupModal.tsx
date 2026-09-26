import { useRef, useState } from 'react';
import Modal from './shared/Modal';
import { PortalMenu, anchorBelow, type AnchorRect } from './shared/PortalDropdown';

interface Props {
  /** How many hosts are moving, for the title. */
  count: number;
  /** The groups already in use, offered as the field is typed in. */
  groups: string[];
  /** A group name, or null for no group. */
  onMove: (group: string | null) => void;
  onClose: () => void;
}

/**
 * Asks which group some hosts should go into.
 *
 * The same free-text field with suggestions the host form has, since a group
 * is only a name: typing a new one makes it. Left blank, the hosts leave
 * whatever group they were in.
 */
export default function MoveToGroupModal({ count, groups, onMove, onClose }: Props) {
  const [group, setGroup] = useState('');
  const [rect, setRect] = useState<AnchorRect | null>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const typed = group.trim().toLowerCase();
  const suggestions = groups.filter((g) => g.toLowerCase().includes(typed) && g !== group.trim());

  return (
    <Modal
      title={`Move ${count} ${count === 1 ? 'host' : 'hosts'} to a group`}
      onClose={onClose}
      onSubmit={(e) => {
        e.preventDefault();
        onMove(group.trim() || null);
      }}
    >
      <div className="form-group" ref={fieldRef}>
        <label>Group</label>
        <input
          autoFocus
          value={group}
          onChange={(e) => setGroup(e.target.value)}
          onFocus={() => setRect(anchorBelow(fieldRef.current?.querySelector('input')))}
          onBlur={() => setTimeout(() => setRect(null), 150)}
          placeholder="A new or existing group; blank for none"
          autoComplete="off"
          spellCheck={false}
        />
        {rect && suggestions.length > 0 && (
          <PortalMenu rect={rect} maxHeight={220}>
            {suggestions.map((g) => (
              <button
                key={g}
                type="button"
                className="picker-item"
                onMouseDown={(e) => { e.preventDefault(); setGroup(g); setRect(null); }}
              >
                {g}
              </button>
            ))}
          </PortalMenu>
        )}
      </div>
      <div className="modal-actions">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="submit" className="btn-primary">
          {group.trim() ? `Move to ${group.trim()}` : 'Remove from group'}
        </button>
      </div>
    </Modal>
  );
}
