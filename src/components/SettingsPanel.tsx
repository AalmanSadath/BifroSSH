import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import PassphraseInput from './PassphraseInput';
import { useAppStore } from '../store/appStore';
import type { KeystoreStatus, Settings } from '../types';

const CURSOR_STYLES = [
  { value: 'block', label: 'Block' },
  { value: 'underline', label: 'Underline' },
  { value: 'bar', label: 'Bar' },
];

function CursorStylePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const label = CURSOR_STYLES.find((s) => s.value === value)?.label ?? value;

  function openPicker() {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setRect({ top: r.bottom + 2, left: r.left, width: r.width });
    setOpen(true);
  }

  return (
    <>
      <button ref={btnRef} type="button" className="picker-btn" onClick={openPicker}>
        <span>{label}</span>
        <svg width="10" height="6" viewBox="0 0 10 6" fill="currentColor"><path d="M0 0l5 6 5-6z"/></svg>
      </button>
      {open && rect && createPortal(
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 9998 }} onMouseDown={() => setOpen(false)} />
          <div className="picker-menu" style={{ position: 'fixed', top: rect.top, left: rect.left, width: rect.width, zIndex: 9999 }}>
            {CURSOR_STYLES.map((s) => (
              <button
                key={s.value}
                type="button"
                className={`picker-item${value === s.value ? ' selected' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); onChange(s.value); setOpen(false); }}
              >
                {s.label}
              </button>
            ))}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}

/**
 * Where the key that encrypts everything is kept, and what that is worth.
 *
 * This reports the mechanism actually in force rather than the best one
 * available. Falling back quietly to a key on disk while implying it is in the
 * keyring would be worse than not having the feature at all.
 */
function MasterKeySection() {
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
      if (s.always_ask) return '';
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
              {error && <p className="form-hint" style={{ color: 'var(--danger)' }}>{error}</p>}
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

              {error && <p className="form-hint" style={{ color: 'var(--danger)' }}>{error}</p>}

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

export default function SettingsPanel() {
  const { settings, saveSettings, setActiveTab } = useAppStore();
  const [connTimeoutStr, setConnTimeoutStr] = useState(String(settings.connection_timeout_secs));
  const [sftpTimeoutStr, setSftpTimeoutStr] = useState(String(settings.sftp_inactivity_timeout_secs));
  const [keepaliveStr, setKeepaliveStr] = useState(String(settings.keepalive_interval_secs));

  useEffect(() => { setConnTimeoutStr(String(settings.connection_timeout_secs)); }, [settings.connection_timeout_secs]);
  useEffect(() => { setSftpTimeoutStr(String(settings.sftp_inactivity_timeout_secs)); }, [settings.sftp_inactivity_timeout_secs]);
  useEffect(() => { setKeepaliveStr(String(settings.keepalive_interval_secs)); }, [settings.keepalive_interval_secs]);

  function patch(p: Partial<Settings>) {
    saveSettings({ ...settings, ...p });
  }

  return (
    <div className="panel">
      <div className="panel-title">Settings</div>

      <section className="panel-section">
        <h3>Appearance</h3>
        <div className="form-group">
          <label>App Theme</label>
          <div className="toggle-row" style={{ maxWidth: 240 }}>
            <button
              type="button"
              className={`toggle-btn${settings.app_theme === 'dark' ? ' active' : ''}`}
              onClick={() => patch({ app_theme: 'dark' })}
            >
              Dark
            </button>
            <button
              type="button"
              className={`toggle-btn${settings.app_theme === 'light' ? ' active' : ''}`}
              onClick={() => patch({ app_theme: 'light' })}
            >
              Light
            </button>
            <button
              type="button"
              className={`toggle-btn${settings.app_theme === 'amoled' ? ' active' : ''}`}
              onClick={() => patch({ app_theme: 'amoled' })}
            >
              AMOLED
            </button>
          </div>
        </div>
      </section>

      <section className="panel-section">
        <h3>Font</h3>
        <div className="form-row">
          <div className="form-group flex-1">
            <label>Family</label>
            <input
              value={settings.font_family}
              onChange={(e) => patch({ font_family: e.target.value })}
              placeholder="monospace"
            />
          </div>
          <div className="form-group port-group">
            <label>Size</label>
            <input
              type="number"
              min={8}
              max={32}
              value={settings.font_size}
              onChange={(e) => patch({ font_size: Number(e.target.value) })}
            />
          </div>
        </div>
      </section>

      <section className="panel-section">
        <h3>Cursor</h3>
        <div className="form-group">
          <label>Style</label>
          <CursorStylePicker value={settings.cursor_style} onChange={(v) => patch({ cursor_style: v })} />
        </div>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.cursor_blink}
            onChange={(e) => patch({ cursor_blink: e.target.checked })}
          />
          <span>Cursor blink</span>
        </label>
      </section>

      <section className="panel-section">
        <h3>Connection</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <label style={{ margin: 0, whiteSpace: 'nowrap' }}>Global timeout (seconds)</label>
          <input
            type="number"
            min={1}
            max={3600}
            value={connTimeoutStr}
            onChange={(e) => setConnTimeoutStr(e.target.value)}
            onBlur={() => {
              const v = Math.min(3600, Math.max(1, Number(connTimeoutStr) || 1));
              setConnTimeoutStr(String(v));
              patch({ connection_timeout_secs: v });
            }}
            style={{ width: 80 }}
            className="no-spinner"
          />
        </div>
        <p className="form-hint">Connection attempt timeout. Per-host timeout can be set in host settings and overrides this value.</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
          <label style={{ margin: 0, whiteSpace: 'nowrap' }}>SFTP inactivity timeout (seconds)</label>
          <input
            type="number"
            min={30}
            max={86400}
            value={sftpTimeoutStr}
            onChange={(e) => setSftpTimeoutStr(e.target.value)}
            onBlur={() => {
              const v = Math.min(86400, Math.max(30, Number(sftpTimeoutStr) || 30));
              setSftpTimeoutStr(String(v));
              patch({ sftp_inactivity_timeout_secs: v });
            }}
            style={{ width: 80 }}
            className="no-spinner"
          />
        </div>
        <p className="form-hint">How long an idle SFTP session is kept alive.</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
          <label style={{ margin: 0, whiteSpace: 'nowrap' }}>Keepalive interval (seconds)</label>
          <input
            type="number"
            min={0}
            max={3600}
            value={keepaliveStr}
            onChange={(e) => setKeepaliveStr(e.target.value)}
            onBlur={() => {
              const v = Math.min(3600, Math.max(0, Number(keepaliveStr) || 0));
              setKeepaliveStr(String(v));
              patch({ keepalive_interval_secs: v });
            }}
            style={{ width: 80 }}
            className="no-spinner"
          />
        </div>
        <p className="form-hint">
          Sends a periodic keepalive on terminal sessions and tunnels so they are not dropped by
          a NAT or firewall idle timer, and so a dead connection is noticed rather than hanging.
          A connection is considered lost after three unanswered keepalives. Set to 0 to disable.
          Does not apply to SFTP, which uses the inactivity timeout above instead.
        </p>
      </section>

      <section className="panel-section">
        <h3>Host keys</h3>
        <p className="form-hint" style={{ marginTop: 0 }}>
          Server fingerprints and how new servers are trusted are managed on the{' '}
          <button type="button" className="link-btn" onClick={() => setActiveTab('knownhosts')}>
            Known Hosts
          </button>{' '}
          page.
        </p>
      </section>

      <MasterKeySection />

      <section className="panel-section">
        <h3>Interface</h3>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.show_hover_hints}
            onChange={(e) => patch({ show_hover_hints: e.target.checked })}
          />
          <span>Show hover hints</span>
        </label>
        <p className="form-hint">Toggles hints while hovering.</p>
      </section>
    </div>
  );
}
