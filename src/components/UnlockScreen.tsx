import { useEffect, useRef, useState } from 'react';
import * as ipc from '../ipc';
import PassphraseInput from './shared/PassphraseInput';
import { isAndroid } from '../platform';

interface Props {
  /** Set when the keystore cannot be opened at all, so no passphrase helps. */
  fatal: string | null;
  /** The keyring would normally have opened this, but it is locked. */
  keyringLocked: boolean;
  /** Fingerprint unlock is on (Android). */
  biometric?: boolean;
  /** An app PIN is set (Android). */
  pin?: boolean;
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
export default function UnlockScreen({ fatal, keyringLocked, biometric = false, pin = false, onUnlocked }: Props) {
  const [passphrase, setPassphrase] = useState('');
  // Fingerprint and PIN can switch themselves off while this is up: a
  // fingerprint change destroys the key, five wrong PINs remove the PIN.
  const [fingerprintOn, setFingerprintOn] = useState(biometric);
  const [pinOn, setPinOn] = useState(pin);
  const [usePassphrase, setUsePassphrase] = useState(!pin);
  const [pinValue, setPinValue] = useState('');
  // Asked for rather than spelled out: the directory differs by platform, and
  // recovery advice that names the wrong one sends the user to an empty folder.
  const [dataDir, setDataDir] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    ipc.dataDir().then(setDataDir).catch(() => {});
  }, []);

  /** Asks for a fingerprint. A cancelled prompt says nothing. */
  async function fingerprint() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      if (await ipc.unlockVaultBiometric()) onUnlocked();
    } catch (err) {
      setError(String(err));
      // The key may be gone (fingerprints changed), so ask what is left.
      ipc.vaultStatus().then((v) => setFingerprintOn(v.biometric)).catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  // Straight away, once: a phone that unlocks by fingerprint should not need
  // a tap to be asked. Guarded because development mounts effects twice.
  const asked = useRef(false);
  useEffect(() => {
    if (!biometric || fatal || asked.current) return;
    asked.current = true;
    void fingerprint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submitPin(e: React.FormEvent) {
    e.preventDefault();
    if (!pinValue || busy) return;
    setBusy(true);
    setError(null);
    try {
      const attempt = await ipc.unlockVaultPin(pinValue);
      if (attempt.result === 'opened') {
        onUnlocked();
      } else if (attempt.result === 'wrong') {
        setError(`Wrong PIN. ${attempt.tries_left} ${attempt.tries_left === 1 ? 'try' : 'tries'} left.`);
      } else {
        setPinOn(false);
        setUsePassphrase(true);
        setError('Too many wrong PINs, so the PIN is off. Use your master passphrase.');
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setPinValue('');
      setBusy(false);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!passphrase || busy) return;
    setBusy(true);
    setError(null);
    try {
      await ipc.unlockVault(passphrase);
      onUnlocked();
    } catch (err) {
      setError(String(err));
      setPassphrase('');
    } finally {
      setBusy(false);
    }
  }

  const showPin = pinOn && !usePassphrase && !fatal;

  return (
    <div className="unlock-screen">
      <form className="unlock-card" onSubmit={showPin ? submitPin : submit}>
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
              {dataDir ? <code>{dataDir}</code> : 'the BifroSSH data folder'} from a backup
              {isAndroid ? '' : ', keyring and all,'} is the way back.
            </p>
          </>
        ) : showPin ? (
          <>
            <p className="unlock-prompt">Enter your PIN to unlock your saved servers and keys.</p>
            <input
              type="text"
              className="pin-input"
              inputMode="numeric"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              autoFocus
              disabled={busy}
              placeholder="PIN"
              value={pinValue}
              onChange={(e) => setPinValue(e.target.value.replace(/\D/g, ''))}
            />
            {error && <p className="unlock-error">{error}</p>}
            <button type="submit" className="btn-primary" disabled={busy || !pinValue}>
              {busy ? 'Unlocking…' : 'Unlock'}
            </button>
            {fingerprintOn && (
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => void fingerprint()}>
                Use fingerprint
              </button>
            )}
            <button type="button" className="unlock-switch" onClick={() => { setError(null); setUsePassphrase(true); }}>
              Use master passphrase
            </button>
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
            {fingerprintOn && (
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => void fingerprint()}>
                Use fingerprint
              </button>
            )}
            {pinOn && (
              <button type="button" className="unlock-switch" onClick={() => { setError(null); setUsePassphrase(false); }}>
                Use PIN
              </button>
            )}
          </>
        )}
      </form>
    </div>
  );
}
