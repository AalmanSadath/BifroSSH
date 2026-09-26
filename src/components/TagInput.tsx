import { useRef, useState } from 'react';
import { PortalMenu, anchorBelow, type AnchorRect } from './shared/PortalDropdown';
import { normalizeTags } from '../hosts';

interface Props {
  tags: string[];
  onChange: (tags: string[]) => void;
  /** Tags already in use elsewhere, offered as the field is typed in. */
  known: string[];
}

/**
 * A row of tag chips with a field at the end.
 *
 * Enter or a comma turns what is typed into a chip, Backspace in the empty
 * field takes the last chip back, and ✕ removes one. What is still typed
 * when the field loses focus is kept as a chip rather than silently lost.
 */
export default function TagInput({ tags, onChange, known }: Props) {
  const [text, setText] = useState('');
  const [rect, setRect] = useState<AnchorRect | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const add = (raw: string) => {
    const next = normalizeTags([...tags, ...raw.split(',')]);
    if (next.length !== tags.length) onChange(next);
    setText('');
  };

  const typed = text.trim().toLowerCase();
  const suggestions = known.filter(
    (k) => k.toLowerCase().includes(typed) && !tags.some((t) => t.toLowerCase() === k.toLowerCase()),
  );

  return (
    <div className="tag-input" ref={boxRef} onClick={() => boxRef.current?.querySelector('input')?.focus()}>
      {tags.map((t) => (
        <span key={t} className="tag-chip">
          {t}
          <button
            type="button"
            className="tag-chip-remove"
            aria-label={`Remove ${t}`}
            onClick={(e) => { e.stopPropagation(); onChange(tags.filter((x) => x !== t)); }}
          >
            ✕
          </button>
        </span>
      ))}
      <input
        value={text}
        onChange={(e) => {
          const v = e.target.value;
          if (v.includes(',')) add(v);
          else setText(v);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && text.trim() !== '') {
            e.preventDefault();
            add(text);
          } else if (e.key === 'Backspace' && text === '' && tags.length > 0) {
            onChange(tags.slice(0, -1));
          }
        }}
        onFocus={() => setRect(anchorBelow(boxRef.current))}
        onBlur={() => {
          if (text.trim() !== '') add(text);
          setTimeout(() => setRect(null), 150);
        }}
        placeholder={tags.length === 0 ? 'web, eu-west' : ''}
        autoComplete="off"
        spellCheck={false}
      />
      {rect && suggestions.length > 0 && (
        <PortalMenu rect={rect} maxHeight={220}>
          {suggestions.map((k) => (
            <button
              key={k}
              type="button"
              className="picker-item"
              onMouseDown={(e) => { e.preventDefault(); add(k); }}
            >
              {k}
            </button>
          ))}
        </PortalMenu>
      )}
    </div>
  );
}
