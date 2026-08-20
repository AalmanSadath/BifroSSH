import { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import PassphraseInput from './shared/PassphraseInput';
import type { KeystoreStatus } from '../types';

/**
 * Where the key that encrypts everything is kept, and what that is worth.
 *
 * This reports the mechanism actually in force rather than the best one
 * available. Falling back quietly to a key on disk while implying it is in the
 * keyring would be worse than not having the feature at all.
 */
export default function MasterKeySection() {
  const [status, setStatus] = useState<KeystoreStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [mode, setMode] = useState<'idle' | 'set' | 'remove'>('idle');
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [understood, setUnderstood] = useState(false);
  const [alwaysAsk, setAlwaysAsk] = useState(false);

  const refresh = () =>
    invoke<KeystoreStatus>('keystore_status')
      .then(setStatus)
      .catch((e) => setError(String(e)));

  useEffect(() => { refresh(); }, []);

  function reset() {
    setMode('idle');
    setPass('');
    setConfirm('');
    setUnderstood(false);
    setAlwaysAsk(false);
    setError(null);
  }

  async function apply() {
    setError(null);
    if (mode === 'set' && pass !== confirm) {
      setError('The two passphrases do not match.');
      return;
    }
    setBusy(true);
    try {
      await invoke(mode === 'set' ? 'set_master_passphrase' : 'remove_master_passphrase', {
        passphrase: pass,
        ...(mode === 'set' ? { alwaysAsk } : {}),
      });
      setNote(
        mode === 'set'
          ? alwaysAsk
            ? 'Passphrase set. It will be asked for every time BifroSSH starts.'
            : 'Passphrase set. Your keyring still unlocks normally; the passphrase is there for when it cannot.'
          : 'Passphrase removed.',
      );
      reset();
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const where = {
    keyring: 'in your desktop keyring',
    file: 'in a file next to your data',
    passphrase: 'behind your master passphrase',
  };

  /**
   * One sentence, and only when it adds something the status line does not.
   * The checkbox below explains itself, so repeating its effect here was three
   * paragraphs saying the same thing.
   */
  function detail(s: KeystoreStatus) {
    if (s.source === 'keyring') {
      return 'The passphrase is only needed if the keyring is ever lost.';
    }
    if (s.source === 'passphrase') {
      if (s.always_ask) return null;
      return s.keyring_locked
        ? 'Your keyring is locked, so the passphrase is what opens it until you unlock the keyring.'
        : 'No desktop keyring answered here, so the passphrase is what opens it.';
    }
    if (s.keyring_available) {
      return 'Anything that copies your home directory copies the key too. Set a passphrase to move it into your keyring.';
    }
    return s.keyring_locked
      ? 'Anything that copies your home directory copies the key too. Your keyring is locked, so unlock it to have it hold the key instead.'
      : 'Anything that copies your home directory copies the key too. No keyring answered here, so a passphrase is the only way off disk.';
  }

  return (
    <section className="panel-section">
      <h3>Master key</h3>

      {!status ? (
        <p className="form-hint" style={{ marginTop: 0 }}>Checking…</p>
      ) : (
        <>
          <p className="form-hint" style={{ marginTop: 0 }}>
            Your saved passwords and private keys are encrypted with one key, held{' '}
            <strong>{where[status.source]}</strong>. {detail(status)}
          </p>

          {note && <p className="form-hint">{note}</p>}

          {mode === 'idle' ? (
            <>
              {status.passphrase_set && (
                <>
                  <label className="checkbox-row master-key-toggle">
                    <input
                      type="checkbox"
                      checked={status.always_ask}
                      disabled={busy}
                      onChange={async (e) => {
                        setBusy(true);
                        setError(null);
                        try {
                          await invoke('set_always_ask', { alwaysAsk: e.target.checked });
                          setNote(null);
                          await refresh();
                        } catch (err) {
                          setError(String(err));
                        } finally {
                          setBusy(false);
                        }
                      }}
                    />
                    <span>Always ask for the passphrase, even when the keyring could unlock it</span>
                  </label>
                  {status.always_ask && (
                    <p className="form-hint">
                      Nothing else can open your data, and a forgotten passphrase cannot be recovered.
                    </p>
                  )}
                </>
              )}
              {error && <p className="form-hint form-hint-error">{error}</p>}
              <div className="modal-actions" style={{ justifyContent: 'flex-start', paddingTop: 4 }}>
                {status.passphrase_set ? (
                  <button className="btn-secondary" onClick={() => { reset(); setMode('remove'); }}>
                    Remove passphrase
                  </button>
                ) : (
                  <button className="btn-secondary" onClick={() => { reset(); setMode('set'); }}>
                    Set a master passphrase
                  </button>
                )}
              </div>
            </>
          ) : (
            <div className="hostkey-confirm">
              {mode === 'set' && (
                <div className={alwaysAsk ? 'hostkey-warn' : ''}>
                  {alwaysAsk ? (
                    <>
                      <strong>This will be the only way in.</strong>
                      <p>
                        Your keyring will no longer be allowed to unlock BifroSSH, and the key is
                        removed from disk. That is what keeps your saved passwords and keys from
                        anything else running as you, and it means nobody, including you, can open
                        them without this passphrase. Forget it and they are gone.
                      </p>
                    </>
                  ) : (
                    <p className="form-hint" style={{ marginTop: 0 }}>
                      The key is removed from disk and your passphrase replaces it. Your keyring
                      still unlocks BifroSSH without asking, so you will only be prompted on a
                      machine where the keyring is unavailable. You cannot be locked out: either
                      the keyring or this passphrase will open it.
                    </p>
                  )}
                </div>
              )}

              {mode === 'remove' && (
                <div className="hostkey-warn">
                  <strong>This puts the key back in a file on disk.</strong>
                  <p>
                    Without a passphrase there has to be something that can still open your data,
                    so removing it writes the key to <code>.secret</code> next to that data. From
                    then on anything that copies your home directory, a backup or a synced folder,
                    copies the key along with it{status.always_ask
                      ? ', and BifroSSH will stop asking you for anything at startup'
                      : ''}.
                  </p>
                </div>
              )}

              <label htmlFor="master-pass">
                {mode === 'set' ? 'New passphrase' : 'Current passphrase'}
              </label>
              <PassphraseInput
                id="master-pass"
                value={pass}
                autoFocus
                autoComplete={mode === 'remove' ? 'current-password' : 'new-password'}
                onChange={setPass}
              />

              {mode === 'set' && (
                <>
                  <label htmlFor="master-pass-confirm">Confirm passphrase</label>
                  <PassphraseInput
                    id="master-pass-confirm"
                    value={confirm}
                    onChange={setConfirm}
                  />
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={alwaysAsk}
                      onChange={(e) => { setAlwaysAsk(e.target.checked); setUnderstood(false); }}
                    />
                    <span>Always ask, even when the keyring could unlock it</span>
                  </label>
                  {alwaysAsk && (
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={understood}
                        onChange={(e) => setUnderstood(e.target.checked)}
                      />
                      <span>I understand this cannot be recovered if I forget it</span>
                    </label>
                  )}
                </>
              )}

              {error && <p className="form-hint form-hint-error">{error}</p>}

              <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
                <button className="btn-secondary" onClick={reset} disabled={busy}>
                  Cancel
                </button>
                <button
                  className={mode === 'set' ? 'btn-primary' : 'btn-danger'}
                  disabled={busy || !pass || (mode === 'set' && alwaysAsk && !understood)}
                  onClick={apply}
                >
                  {busy ? 'Working…' : mode === 'set' ? 'Set passphrase' : 'Remove passphrase'}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
