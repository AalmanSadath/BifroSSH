import { useState } from 'react';
import * as ipc from '../ipc';
import PassphraseInput from './shared/PassphraseInput';
import type { KeystoreStatus } from '../types';

/** Shortest PIN the backend accepts (`PIN_MIN_DIGITS` in keystore.rs). */
const PIN_MIN_DIGITS = 6;

interface Props {
  status: KeystoreStatus | null;
  /** Something was turned on or off; the status needs reading again. */
  onChanged: () => void;
}

/**
 * Fingerprint and app PIN, the quicker ways into the vault on Android.
 *
 * Both sit beside the master passphrase and need it to be turned on: they
 * live on this phone only and can stop working (a fingerprint change, five
 * wrong PINs), and the passphrase is what still opens the vault when they
 * do. Turning one on asks for the passphrase so that someone at an unlocked
 * phone cannot add a way in of their own.
 */
export default function QuickUnlockSection({ status, onChanged }: Props) {
  const [mode, setMode] = useState<'idle' | 'fingerprint' | 'pin'>('idle');
  const [pass, setPass] = useState('');
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  function reset() {
    setMode('idle');
    setPass('');
    setPin('');
    setConfirm('');
    setError(null);
  }

  async function run(action: () => Promise<string | null>) {
    setBusy(true);
    setError(null);
    try {
      const done = await action();
      if (done !== null) {
        setNote(done);
        reset();
        onChanged();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function apply() {
    if (mode === 'pin') {
      if (pin.length < PIN_MIN_DIGITS) {
        setError(`The PIN must be at least ${PIN_MIN_DIGITS} digits.`);
        return;
      }
      if (pin !== confirm) {
        setError('The two PINs do not match.');
        return;
      }
      void run(async () => {
        await ipc.setAppPin(pass, pin);
        return 'PIN set. BifroSSH asks for it when it is locked.';
      });
    } else {
      // A cancelled fingerprint prompt leaves the form open for another go.
      void run(async () =>
        (await ipc.enableBiometric(pass)) ? 'Fingerprint unlock is on.' : null,
      );
    }
  }

  const digits = (v: string) => v.replace(/\D/g, '');

  if (!status) return null;
  const canUse = status.passphrase_set;

  return (
    <section className="panel-section">
      <h3>Fingerprint and PIN</h3>
      <p className="form-hint form-hint-flush">
        {canUse
          ? 'Quicker ways to unlock on this phone. Your master passphrase still works, and is what you need if these stop working.'
          : 'Set a master passphrase first. It is how you get back in if fingerprint or PIN unlock ever stops working.'}
      </p>

      {note && <p className="form-hint">{note}</p>}

      {mode === 'idle' ? (
        <>
          {error && <p className="form-hint form-hint-error">{error}</p>}
          <div className="modal-actions modal-actions-start modal-actions-pad">
            {status.biometric_enabled ? (
              <button
                className="btn-secondary"
                disabled={busy}
                onClick={() => void run(async () => {
                  await ipc.disableBiometric();
                  return 'Fingerprint unlock is off.';
                })}
              >
                Turn off fingerprint
              </button>
            ) : (
              <button
                className="btn-secondary"
                disabled={busy || !canUse || !status.biometric_available}
                onClick={() => { reset(); setNote(null); setMode('fingerprint'); }}
              >
                Use fingerprint
              </button>
            )}
            <button
              className="btn-secondary"
              disabled={busy || !canUse}
              onClick={() => { reset(); setNote(null); setMode('pin'); }}
            >
              {status.pin_enabled ? 'Change PIN' : 'Set a PIN'}
            </button>
            {status.pin_enabled && (
              <button
                className="btn-secondary"
                disabled={busy}
                onClick={() => void run(async () => {
                  await ipc.removeAppPin();
                  return 'PIN removed.';
                })}
              >
                Remove PIN
              </button>
            )}
          </div>
          {canUse && !status.biometric_enabled && !status.biometric_available && status.biometric_reason && (
            <p className="form-hint">{status.biometric_reason}</p>
          )}
        </>
      ) : (
        <div className="master-key-form">
          <p className="form-hint form-hint-flush">
            {mode === 'pin'
              ? `At least ${PIN_MIN_DIGITS} digits. After 5 wrong tries the PIN is switched off and the master passphrase is needed.`
              : 'Android asks for your fingerprint next. Adding or removing a fingerprint in Android settings switches this off again.'}
          </p>

          <label htmlFor="quick-pass">Master passphrase</label>
          <PassphraseInput
            id="quick-pass"
            value={pass}
            autoFocus
            autoComplete="current-password"
            onChange={setPass}
          />

          {mode === 'pin' && (
            <>
              <label htmlFor="quick-pin">New PIN</label>
              <input
                id="quick-pin"
                type="text"
                className="pin-input"
                inputMode="numeric"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                value={pin}
                onChange={(e) => setPin(digits(e.target.value))}
              />
              <label htmlFor="quick-pin-confirm">Confirm PIN</label>
              <input
                id="quick-pin-confirm"
                type="text"
                className="pin-input"
                inputMode="numeric"
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                value={confirm}
                onChange={(e) => setConfirm(digits(e.target.value))}
              />
            </>
          )}

          {error && <p className="form-hint form-hint-error">{error}</p>}

          <div className="modal-actions modal-actions-start">
            <button className="btn-secondary" onClick={reset} disabled={busy}>
              Cancel
            </button>
            <button
              className="btn-primary"
              disabled={busy || !pass || (mode === 'pin' && (!pin || !confirm))}
              onClick={apply}
            >
              {busy ? 'Working…' : mode === 'pin' ? 'Set PIN' : 'Turn on'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
