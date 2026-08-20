import { useEffect, useState } from 'react';

interface Props {
  label: string;
  value: number;
  min: number;
  max: number;
  /** Called with the clamped value once the box loses focus. */
  onCommit: (value: number) => void;
}

/**
 * A labelled number box that clamps on blur and saves what it clamped to.
 *
 * Three of these existed in the settings panel, identical apart from their
 * label and their bounds, each backed by its own `useState` for the text being
 * typed and its own `useEffect` mirroring the saved value back into it. That
 * is three states and three effects for three numbers.
 *
 * The text is held separately from the number because a half-typed value is
 * not one: clamping while someone is still typing turns "10" into "1" the
 * moment they pause on the first character.
 */
export default function NumberSetting({ label, value, min, max, onCommit }: Props) {
  const [text, setText] = useState(String(value));

  // The saved value can change from elsewhere, an import being the obvious way.
  useEffect(() => { setText(String(value)); }, [value]);

  function commit() {
    const clamped = Math.min(max, Math.max(min, Number(text) || min));
    setText(String(clamped));
    onCommit(clamped);
  }

  return (
    <div className="settings-num-row">
      <label>{label}</label>
      <input
        type="number"
        className="no-spinner"
        min={min}
        max={max}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
      />
    </div>
  );
}
