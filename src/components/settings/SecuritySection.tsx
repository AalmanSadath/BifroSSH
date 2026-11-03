import { useEffect, useState } from 'react';
import * as ipc from '../../ipc';
import { useAppStore, reportFailure } from '../../store/appStore';
import MasterKeySection from '../MasterKeySection';
import QuickUnlockSection from '../QuickUnlockSection';
import { Picker, usePatch, type PickerOption } from './Picker';
import { formatChords, resolve } from '../../shortcuts';
import type { KeystoreStatus } from '../../types';
import { isAndroid } from '../../platform';

/** Minutes, as strings because the picker is keyed on strings; 0 is off. */
const AUTO_LOCK_OPTIONS: PickerOption<string>[] = [
  { value: '0', label: 'Off' },
  { value: '5', label: '5 minutes' },
  { value: '15', label: '15 minutes' },
  { value: '30', label: '30 minutes' },
  { value: '60', label: '1 hour' },
];

/** Android's lock on return; 'off' is null in the setting. */
const BACKGROUND_LOCK_OPTIONS: PickerOption<string>[] = [
  { value: 'off', label: 'Off' },
  { value: '0', label: 'Immediately' },
  { value: '1', label: '1 minute' },
  { value: '5', label: '5 minutes' },
  { value: '15', label: '15 minutes' },
];

/** The one sentence every disabled lock control shows. */
const LOCK_NEEDS_PASSPHRASE = 'Set a master passphrase to enable locking.';

/** The master key, locking, and where host keys are managed. */
export default function SecuritySection({ setActiveTab }: { setActiveTab: (id: string) => void }) {
  const { settings, refreshPassphrase } = useAppStore();
  const patch = usePatch();
  // Whether a passphrase is set decides whether locking means anything. Read
  // here and refreshed whenever the master key section changes it.
  const [keystore, setKeystore] = useState<KeystoreStatus | null>(null);
  const refreshKeystore = () => {
    ipc.keystoreStatus().then(setKeystore).catch(() => {});
    refreshPassphrase();
  };
  useEffect(() => { refreshKeystore(); }, []);
  const canLock = keystore?.passphrase_set === true;
  // Without a passphrase the lock settings are kept but not in force, so
  // they read as off until one is set again.
  const shown = canLock ? settings : {
    ...settings, auto_lock_minutes: 0, background_lock_minutes: null, lock_on_suspend: false, lock_on_screen_lock: false,
  };
  const lockChord = formatChords(resolve(settings.shortcuts)['lock-vault']);

  return (
    <>
      <MasterKeySection onChanged={refreshKeystore} />

      {isAndroid && <QuickUnlockSection status={keystore} onChanged={refreshKeystore} />}

      <section className="panel-section">
        <h3>Locking</h3>
        <p className="form-hint form-hint-flush">Open sessions and tunnels stay connected while locked.</p>
        {!canLock && keystore && (
          <p className="form-hint form-hint-warn">{LOCK_NEEDS_PASSPHRASE}</p>
        )}
        <div className="form-row">
          <div className="form-group flex-1">
            <label>Lock after no input for</label>
            <div style={canLock ? undefined : { opacity: 0.5, pointerEvents: 'none' }}>
              <Picker
                value={String(shown.auto_lock_minutes)}
                options={AUTO_LOCK_OPTIONS}
                onChange={(v) => patch({ auto_lock_minutes: Number(v) })}
              />
            </div>
          </div>
        </div>
        {isAndroid && (
          <div className="form-row">
            <div className="form-group flex-1">
              <label>Lock after leaving the app for</label>
              <div style={canLock ? undefined : { opacity: 0.5, pointerEvents: 'none' }}>
                <Picker
                  value={shown.background_lock_minutes === null ? 'off' : String(shown.background_lock_minutes)}
                  options={BACKGROUND_LOCK_OPTIONS}
                  onChange={(v) => patch({ background_lock_minutes: v === 'off' ? null : Number(v) })}
                />
              </div>
            </div>
          </div>
        )}
        {!isAndroid && <label className="checkbox-row">
          <input
            type="checkbox"
            disabled={!canLock}
            checked={shown.lock_on_suspend}
            onChange={(e) => patch({ lock_on_suspend: e.target.checked })}
          />
          <span>Lock before the computer sleeps</span>
        </label>}
        {!isAndroid && <label className="checkbox-row">
          <input
            type="checkbox"
            disabled={!canLock}
            checked={shown.lock_on_screen_lock}
            onChange={(e) => patch({ lock_on_screen_lock: e.target.checked })}
          />
          <span>Lock when the screen locks</span>
        </label>}
        <div className="settings-actions">
          <button
            type="button"
            className="btn-secondary btn-sm"
            disabled={!canLock}
            onClick={() => ipc.lockVault().catch(reportFailure)}
          >
            Lock now
          </button>
          {/* The chord is rebindable, so it is read rather than written out.
              Android has no shortcuts page and usually no keyboard. */}
          {!isAndroid && <span className="form-hint form-hint-flush">or {lockChord} anywhere</span>}
        </div>
      </section>

      <section className="panel-section">
        <h3>Host keys</h3>
        <p className="form-hint form-hint-flush">Managed on the{' '}
          <button type="button" className="link-btn" onClick={() => setActiveTab('knownhosts')}>
            Known Hosts
          </button>{' '}
          page.</p>
      </section>
    </>
  );
}
