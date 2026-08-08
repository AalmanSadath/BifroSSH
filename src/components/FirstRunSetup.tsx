import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import PassphraseInput from './PassphraseInput';

type Mode = 'secret-file' | 'passphrase-only' | 'keyring-and-passphrase';

interface Props {
  keyringAvailable: boolean;
  onReady: () => void;
}

/**
 * Shown once, before a master key exists.
 *
 * The choice is offered rather than made because the three arrangements trade
 * off differently and only the person using it can say which they want. None
 * of it is permanent: all three are reachable from Settings afterwards, which
 * the screen says, because a decision that looks irreversible gets agonised
 * over or clicked past.
 */
export default function FirstRunSetup({ keyringAvailable, onReady }: Props) {
  const [mode, setMode] = useState<Mode>(keyringAvailable ? 'keyring-and-passphrase' : 'secret-file');
  const [passphrase, setPassphrase] = useState('');
  const [generated, setGenerated] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsPassphrase = mode !== 'secret-file';
  // A generated phrase is the one nobody has memorised, so it does not count
  // as chosen until the user says they have put it somewhere.
  const ready = !needsPassphrase || (passphrase.trim() !== '' && (!generated || saved));

  function pick(next: Mode) {
    setMode(next);
    setError(null);
    setPassphrase('');
    setGenerated(false);
    setSaved(false);
    setCopied(false);
  }

  async function roll() {
    setError(null);
    try {
      setPassphrase(await invoke<string>('generate_passphrase'));
      setGenerated(true);
      setSaved(false);
      setCopied(false);
    } catch (e) {
      setError(String(e));
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(passphrase);
      setCopied(true);
    } catch {
      setError('Could not reach the clipboard. Write it down instead.');
    }
  }

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await invoke('initialize_vault', { mode, passphrase });
      onReady();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const options: { id: Mode; title: string; body: string; hidden?: boolean }[] = [
    {
      id: 'keyring-and-passphrase',
      title: 'Desktop keyring, with a passphrase to fall back on',
      body:
        'Your keyring unlocks BifroSSH without asking. The passphrase is only needed if the ' +
        'keyring is ever lost, so nothing can lock you out. The key is not kept on disk.',
      hidden: !keyringAvailable,
    },
    {
      id: 'passphrase-only',
      title: 'Passphrase only, asked every time',
      body:
        'The key exists nowhere until you type it. This is the only option that protects your ' +
        'saved keys from anything else running as you, and the only one where forgetting the ' +
        'passphrase loses them for good.',
    },
    {
      id: 'secret-file',
      title: 'Keep the key in a file, no passphrase',
      body:
        'Simplest, and nothing to remember. The key sits next to your data, readable only by ' +
        'your account, which means anything that copies your home directory copies both.',
    },
  ];

  return (
    <div className="unlock-screen">
      <div className="unlock-card setup-card">
        <h1>BifroSSH</h1>
        <p className="unlock-prompt">
          Your saved passwords and private keys are encrypted with one key. Choose where that key
          should be kept.
        </p>

        {!keyringAvailable && (
          <p className="form-hint">
            No desktop keyring answered on this system, so that option is not available here.
          </p>
        )}

        <div className="setup-options">
          {options.filter((o) => !o.hidden).map((o) => (
            <button
              key={o.id}
              type="button"
              className={`setup-option${mode === o.id ? ' selected' : ''}`}
              onClick={() => pick(o.id)}
            >
              <span className="setup-option-title">{o.title}</span>
              <span className="setup-option-body">{o.body}</span>
            </button>
          ))}
        </div>

        {needsPassphrase && (
          <>
            <div className="setup-pass-row">
              {generated ? (
                // Shown in full rather than on one scrolling line: this is
                // meant to be copied down by hand, and a phrase you cannot see
                // all of at once is one you transcribe wrong.
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
                  placeholder="Passphrase"
                  onChange={(v) => {
                    setPassphrase(v);
                    setSaved(false);
                  }}
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
                <p>
                  Eight words, and the only copy is on your screen.{' '}
                  {mode === 'keyring-and-passphrase'
                    ? 'You may not need it for years, which is exactly why it has to be somewhere you will still find it then.'
                    : 'It is asked for every launch, and nothing else can open your data.'}{' '}
                  Capitals and how you space it do not matter when you type it back.
                </p>
                <div className="setup-phrase-actions">
                  <button type="button" className="btn-secondary" onClick={copy}>
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => { setPassphrase(''); setGenerated(false); setSaved(false); setCopied(false); }}
                  >
                    Type my own instead
                  </button>
                </div>
                <label className="checkbox-row setup-saved-row">
                  <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
                  <span>I have saved this somewhere safe</span>
                </label>
              </div>
            )}
          </>
        )}

        {error && <p className="unlock-error">{error}</p>}

        <button className="btn-primary" disabled={!ready || busy} onClick={create}>
          {busy ? 'Setting up…' : 'Continue'}
        </button>

        <p className="form-hint" style={{ textAlign: 'center' }}>
          You can change this later in Settings.
        </p>
      </div>
    </div>
  );
}
