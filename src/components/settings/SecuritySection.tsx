import { useEffect, useState } from 'react';
import * as ipc from '../../ipc';
import { useAppStore, reportFailure } from '../../store/appStore';
import MasterKeySection from '../MasterKeySection';
import { Picker, usePatch, type PickerOption } from './Picker';
import { formatChords, resolve } from '../../shortcuts';
import type { KeystoreStatus } from '../../types';

/** Minutes, as strings because the picker is keyed on strings; 0 is off. */
const AUTO_LOCK_OPTIONS: PickerOption<string>[] = [
  { value: '0', label: 'Off' },
  { value: '5', label: '5 minutes' },
  { value: '15', label: '15 minutes' },
  { value: '30', label: '30 minutes' },
  { value: '60', label: '1 hour' },
];

/** The one sentence every disabled lock control shows. */
const LOCK_NEEDS_PASSPHRASE = 'Set a master passphrase to enable locking. Without one the keyring would reopen the vault by itself.';

/** The master key, locking, and where host keys are managed. */
export default function SecuritySection({ setActiveTab }: { setActiveTab: (id: string) => void }) {
  const { settings } = useAppStore();
  const patch = usePatch();
  // Whether a passphrase is set decides whether locking means anything. Read
  // here and refreshed whenever the master key section changes it.
  const [keystore, setKeystore] = useState<KeystoreStatus | null>(null);
  const refreshKeystore = () => { ipc.keystoreStatus().then(setKeystore).catch(() => {}); };
  useEffect(() => { refreshKeystore(); }, []);
  const canLock = keystore?.passphrase_set === true;
  const lockChord = formatChords(resolve(settings.shortcuts)['lock-vault']);

  return (
    <>
      <MasterKeySection onChanged={refreshKeystore} />

      <section className="panel-section">
        <h3>Locking</h3>
        <p className="form-hint form-hint-flush">
          A locked vault asks for the master passphrase before anything can be read again.
          Terminal sessions and tunnels that are already open stay connected behind it.
        </p>
        {!canLock && keystore && (
          <p className="form-hint form-hint-warn">{LOCK_NEEDS_PASSPHRASE}</p>
        )}
        <div className="form-row">
          <div className="form-group flex-1">
            <label>Lock after no input for</label>
            <div style={canLock ? undefined : { opacity: 0.5, pointerEvents: 'none' }}>
              <Picker
                value={String(settings.auto_lock_minutes)}
                options={AUTO_LOCK_OPTIONS}
                onChange={(v) => patch({ auto_lock_minutes: Number(v) })}
              />
            </div>
          </div>
        </div>
        <p className="form-hint">
          Input means yours: keys, pointer, wheel. Output arriving in a terminal does not count.
        </p>
        <label className="checkbox-row">
          <input
            type="checkbox"
            disabled={!canLock}
            checked={settings.lock_on_suspend}
            onChange={(e) => patch({ lock_on_suspend: e.target.checked })}
          />
          <span>Lock before the computer sleeps</span>
        </label>
        <div className="form-row" style={{ alignItems: 'center', gap: 10 }}>
          <button
            type="button"
            className="btn-secondary"
            disabled={!canLock}
            onClick={() => ipc.lockVault().catch(reportFailure)}
          >
            Lock now
          </button>
          {/* The chord is rebindable, so it is read rather than written out. */}
          <span className="form-hint form-hint-flush">or {lockChord} anywhere</span>
        </div>
      </section>

      <section className="panel-section">
        <h3>Host keys</h3>
        <p className="form-hint form-hint-flush">
          Server fingerprints and how new servers are trusted are managed on the{' '}
          <button type="button" className="link-btn" onClick={() => setActiveTab('knownhosts')}>
            Known Hosts
          </button>{' '}
          page.
        </p>
      </section>
    </>
  );
}
