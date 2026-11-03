import { useState, useEffect } from 'react';
import * as ipc from '../ipc';
import PassphraseInput from './shared/PassphraseInput';
import type { KeystoreStatus } from '../types';
import { isAndroid } from '../platform';

/**
 * Where the key that encrypts everything is kept, and what that is worth.
 *
 * This reports the mechanism actually in force rather than the best one
 * available. Falling back quietly to a key on disk while implying it is in the
 * keyring would be worse than not having the feature at all.
 */
interface Props {
  /** The passphrase was set or removed, which changes what else can be done. */
  onChanged?: () => void;
}

export default function MasterKeySection({ onChanged }: Props = {}) {
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
    ipc.keystoreStatus()
      .then((st) => { setStatus(st); onChanged?.(); })
      .catch((e) => setError(String(e)));

  // Once, at mount. `refresh` closes over `onChanged`, which the parent may
  // recreate on every render; following it would refetch on each one.
  // eslint-disable-next-line react-hooks/exhaustive-deps
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
      await (mode === 'set'
        ? ipc.setMasterPassphrase(pass, alwaysAsk)
        : ipc.removeMasterPassphrase(pass));
      setNote(
        mode === 'set'
          ? alwaysAsk || isAndroid
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
    file: isAndroid ? 'in a file next to your data in the app\'s storage' : 'in a file next to your data',
    passphrase: 'behind your master passphrase',
  };

  /**
   * One sentence, and only when it adds something the status line does not.
   * The checkbox below explains itself, so repeating its effect here was three
   * paragraphs saying the same thing.
   */
  function detail(s: KeystoreStatus) {
    // Android has no keyring, so the passphrase is the only thing it could
    // be behind, and the file the only alternative.
    if (isAndroid) {
      return s.source === 'file'
        ? 'Phone backups copy the key. Set a passphrase to protect it.'
        : null;
    }
    if (s.source === 'keyring') {
      return 'The passphrase is the fallback if the keyring is lost.';
    }
    if (s.source === 'passphrase') {
      if (s.always_ask) return null;
      return s.keyring_locked
        ? 'Keyring locked; the passphrase opens it for now.'
        : 'No desktop keyring here.';
    }
    if (s.keyring_available) {
      return 'Home folder backups copy the key. Set a passphrase to protect it.';
    }
    return s.keyring_locked
      ? 'Home folder backups copy the key. Unlock your keyring to move it there.'
      : 'Home folder backups copy the key. Set a passphrase to protect it.';
  }

  return (
    <section className="panel-section">
      <h3>Master key</h3>

      {!status ? (
        <p className="form-hint form-hint-flush">Checking…</p>
      ) : (
        <>
          <p className="form-hint form-hint-flush">
            Passwords and keys are encrypted with one key, held{' '}
            <strong>{where[status.source]}</strong>. {detail(status)}
          </p>

          {note && <p className="form-hint">{note}</p>}

          {mode === 'idle' ? (
            <>
              {status.passphrase_set && !isAndroid && (
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
                          await ipc.setAlwaysAsk(e.target.checked);
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
              <div className="modal-actions modal-actions-start modal-actions-pad">
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
            <div className="master-key-form">
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
                  ) : isAndroid ? (
                    <p className="form-hint form-hint-flush">Forgetting the passphrase loses saved passwords and keys.</p>
                  ) : (
                    <p className="form-hint form-hint-flush">Your keyring still unlocks it; the passphrase is the fallback.</p>
                  )}
                </div>
              )}

              {mode === 'remove' && (
                <div className="hostkey-warn">
                  <strong>This puts the key back in a file on disk.</strong>
                  <p>
                    Without a passphrase there has to be something that can still open your data,
                    so removing it writes the key to <code>.secret</code> next to that data. From
                    then on anything that copies {isAndroid
                      ? 'the app\'s storage, such as a phone backup,'
                      : 'your home directory, a backup or a synced folder,'} copies the key along
                    with it{status.always_ask || isAndroid
                      ? ', and BifroSSH will stop asking you for anything at startup'
                      : ''}.
                    {(status.biometric_enabled || status.pin_enabled) &&
                      ' Fingerprint unlock and the app PIN are turned off as well.'}
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
                  {!isAndroid && <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={alwaysAsk}
                      onChange={(e) => { setAlwaysAsk(e.target.checked); setUnderstood(false); }}
                    />
                    <span>Always ask, even when the keyring could unlock it</span>
                  </label>}
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

              <div className="modal-actions modal-actions-start">
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
