import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import PassphraseInput from './shared/PassphraseInput';

interface Props {
  /** Set when the keystore cannot be opened at all, so no passphrase helps. */
  fatal: string | null;
  /** The keyring would normally have opened this, but it is locked. */
  keyringLocked: boolean;
  onUnlocked: () => void;
}

/**
 * Shown in place of the app while the master key is unknown.
 *
 * Nothing is loaded behind this: the backend holds no key yet, so every
 * command that reads or writes saved data fails until the passphrase opens the
 * vault. That is deliberate, and it is what stops anything overwriting the
 * real file with the empty state sitting in memory.
 */
export default function UnlockScreen({ fatal, keyringLocked, onUnlocked }: Props) {
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!passphrase || busy) return;
    setBusy(true);
    setError(null);
    try {
      await invoke('unlock_vault', { passphrase });
      onUnlocked();
    } catch (err) {
      setError(String(err));
      setPassphrase('');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="unlock-screen">
      <form className="unlock-card" onSubmit={submit}>
        <h1>BifroSSH</h1>

        {fatal ? (
          <>
            <div className="hostkey-warn">
              <strong>BifroSSH cannot open its keystore.</strong>
              <p>{fatal}</p>
            </div>
            <p className="form-hint">
              Nothing has been changed on disk. Your data is still there and still encrypted;
              what is missing is the key that opens it. Restoring{' '}
              <code>~/.local/share/bifrossh</code> from a backup, keyring and all, is the way
              back.
            </p>
          </>
        ) : (
          <>
            <p className="unlock-prompt">
              {keyringLocked
                ? 'Your desktop keyring is locked, so it cannot open BifroSSH. Enter your master passphrase instead, or unlock the keyring and restart.'
                : 'Enter your master passphrase to unlock your saved servers and keys.'}
            </p>

            {/* The generated phrase is eight words read back off paper, which
                is the hardest thing in the app to type blind, so this is the
                one place the reveal matters most. */}
            <PassphraseInput
              value={passphrase}
              autoFocus
              disabled={busy}
              autoComplete="current-password"
              placeholder="Master passphrase"
              onChange={setPassphrase}
            />

            {error && <p className="unlock-error">{error}</p>}

            <button type="submit" className="btn-primary" disabled={busy || !passphrase}>
              {busy ? 'Unlocking…' : 'Unlock'}
            </button>
          </>
        )}
      </form>
    </div>
  );
}
