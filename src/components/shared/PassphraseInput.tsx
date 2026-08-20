import { useState } from 'react';

interface Props {
  value: string;
  onChange: (value: string) => void;
  id?: string;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  autoComplete?: string;
  /** For the one caller that hangs a suggestion list off the field. */
  onFocus?: () => void;
  onBlur?: () => void;
  /** Enter to submit, Escape to dismiss, where the field is the whole dialog. */
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  inputRef?: React.Ref<HTMLInputElement>;
}

const EYE = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const EYE_OFF = (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
    <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
    <line x1="1" y1="1" x2="23" y2="23" />
  </svg>
);

/**
 * A passphrase box that can be read back before it is committed to.
 *
 * Worth having wherever a mistyped passphrase is expensive to discover later:
 * the one that encrypts everything is set once and then wanted months
 * afterwards, so a typo in it is not found until it matters most.
 *
 * The toggle is skipped in the tab order. It is a way to check what you typed,
 * not a step on the way to submitting.
 */
export default function PassphraseInput({
  value,
  onChange,
  id,
  placeholder,
  autoFocus,
  disabled,
  autoComplete = 'new-password',
  onFocus,
  onBlur, onKeyDown, inputRef }: Props) {
  const [shown, setShown] = useState(false);

  return (
    <div className="input-with-eye">
      <input
        ref={inputRef}
        id={id}
        type={shown ? 'text' : 'password'}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        disabled={disabled}
        autoComplete={autoComplete}
        spellCheck={false}
        onFocus={onFocus}
        onBlur={onBlur}
        onKeyDown={onKeyDown}
        onChange={(e) => onChange(e.target.value)}
      />
      <button
        type="button"
        className="eye-btn"
        tabIndex={-1}
        aria-label={shown ? 'Hide passphrase' : 'Show passphrase'}
        title={shown ? 'Hide' : 'Show'}
        onClick={() => setShown((v) => !v)}
      >
        {shown ? EYE_OFF : EYE}
      </button>
    </div>
  );
}
