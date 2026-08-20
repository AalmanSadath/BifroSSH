import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import PassphraseInput from './PassphraseInput';

interface Props {
  passphrase: string;
  /** Called with the new phrase, and whether it came from the dice. */
  onChange: (passphrase: string, generated: boolean) => void;
  generated: boolean;
  /** Ticked to say the phrase has been written down; owned by the caller. */
  saved: boolean;
  onSavedChange: (saved: boolean) => void;
  placeholder: string;
  /** Why losing this one matters, which is not the same in both places. */
  warning: React.ReactNode;
  onError: (message: string) => void;
  /** Cleared alongside the phrase when the user goes back to typing. */
  onReset?: () => void;
}

/**
 * A passphrase the user either types or has generated for them.
 *
 * The first-run setup and the encrypted export both need this and each had its
 * own copy, about ninety lines apiece: the same dice button, the same
 * read-only textarea, the same Copy and "Type my own instead" pair, and the
 * same "I have saved this somewhere safe" checkbox. Only the warning differed,
 * because what is lost differs: one is the key to everything on this machine,
 * the other is the key to one file.
 *
 * A generated phrase is shown in a textarea rather than an input on purpose.
 * It is meant to be written down, and a phrase you cannot see all of at once
 * is one you transcribe wrong.
 */
export default function GeneratedPassphraseField({
  passphrase,
  onChange,
  generated,
  saved,
  onSavedChange,
  placeholder,
  warning,
  onError,
  onReset,
}: Props) {
  const [copied, setCopied] = useState(false);

  async function roll() {
    try {
      onChange(await invoke<string>('generate_passphrase'), true);
      onSavedChange(false);
      setCopied(false);
    } catch (e) {
      onError(String(e));
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(passphrase);
      setCopied(true);
    } catch {
      onError('Could not reach the clipboard. Write it down instead.');
    }
  }

  function typeMyOwn() {
    onChange('', false);
    onSavedChange(false);
    setCopied(false);
    onReset?.();
  }

  return (
    <>
      <div className="setup-pass-row">
        {generated ? (
          <textarea
            className="setup-phrase"
            value={passphrase}
            readOnly
            rows={2}
            spellCheck={false}
            onFocus={(e) => e.currentTarget.select()}
          />
        ) : (
          <PassphraseInput
            value={passphrase}
            placeholder={placeholder}
            onChange={(v) => { onChange(v, false); onSavedChange(false); }}
          />
        )}
        <button
          type="button"
          className="btn-secondary"
          title={generated ? 'Generate a different one' : 'Generate one'}
          onClick={roll}
        >
          🎲
        </button>
      </div>

      {generated && (
        <div className="hostkey-warn">
          <strong>Write this down before continuing.</strong>
          {warning}
          <div className="setup-phrase-actions">
            <button type="button" className="btn-secondary" onClick={copy}>
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button type="button" className="link-btn" onClick={typeMyOwn}>
              Type my own instead
            </button>
          </div>
          <label className="checkbox-row setup-saved-row">
            <input type="checkbox" checked={saved} onChange={(e) => onSavedChange(e.target.checked)} />
            <span>I have saved this somewhere safe</span>
          </label>
        </div>
      )}
    </>
  );
}
