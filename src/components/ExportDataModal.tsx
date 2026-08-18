import { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import PassphraseInput from './shared/PassphraseInput';
import FilePickerModal from './FilePickerModal';
import type { ExportResult } from '../types';
import Modal from './shared/Modal';

interface Props {
  onClose: () => void;
}

function defaultName(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `bifrossh-export-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.bfx`;
}

/**
 * Writes everything this install holds into one passphrase-sealed file.
 *
 * The passphrase is not the master key and is never stored: secrets are
 * unwrapped from the local key and rewrapped under this one, which is what
 * lets the file open on a machine that has never seen this keystore.
 */
export default function ExportDataModal({ onClose }: Props) {
  const [dir, setDir] = useState('');
  const [path, setPath] = useState('');
  const [picking, setPicking] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [confirmPass, setConfirmPass] = useState('');
  const [generated, setGenerated] = useState(false);
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [includeSecrets, setIncludeSecrets] = useState(true);
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ExportResult | null>(null);

  useEffect(() => {
    invoke<string>('default_export_dir')
      .then((d) => {
        setDir(d);
        setPath(`${d.replace(/\/+$/, '')}/${defaultName()}`);
      })
      .catch((e) => setError(String(e)));
  }, []);

  async function roll() {
    setError('');
    try {
      const phrase = await invoke<string>('generate_passphrase');
      setPassphrase(phrase);
      setConfirmPass(phrase);
      setGenerated(true);
      setCopied(false);
      setSaved(false);
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

  const matched = passphrase.length > 0 && passphrase === confirmPass;
  // A generated phrase is nowhere but the screen until the user says otherwise.
  const ready = Boolean(path) && matched && (!generated || saved) && !busy;

  async function run(force: boolean) {
    setBusy(true);
    setError('');
    try {
      const res = await invoke<ExportResult>('export_data', {
        path,
        passphrase,
        includeSecrets,
        overwrite: force,
      });
      setResult(res);
    } catch (e) {
      const message = String(e);
      if (!force && message.includes('already exists')) {
        setOverwrite(true);
        setError(`${path} already exists. Export again to replace it.`);
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  if (picking) {
    return (
      <FilePickerModal
        mode="save"
        title="Where should the export go?"
        startDir={path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : dir}
        defaultName={path.slice(path.lastIndexOf('/') + 1) || defaultName()}
        extensions={['.bfx']}
        onCancel={() => setPicking(false)}
        onChoose={(chosen) => {
          setPath(chosen);
          setOverwrite(false);
          setError('');
          setPicking(false);
        }}
      />
    );
  }

  return (
    <Modal
      className="transfer-modal"
      title="Export settings"
      subtitle="One encrypted file you can carry to another machine"
      onClose={onClose}
    >
      {result ? (
        <>
          <p className="hostkey-body">
            Wrote {result.counts.servers} host{result.counts.servers === 1 ? '' : 's'},{' '}
            {result.counts.identities} identit{result.counts.identities === 1 ? 'y' : 'ies'},{' '}
            {result.counts.keys} key{result.counts.keys === 1 ? '' : 's'},{' '}
            {result.counts.port_forwardings} tunnel{result.counts.port_forwardings === 1 ? '' : 's'},{' '}
            {result.counts.codeprints} codeprint{result.counts.codeprints === 1 ? '' : 's'},{' '}
            {result.counts.custom_themes} theme{result.counts.custom_themes === 1 ? '' : 's'} and{' '}
            {result.counts.known_hosts} known host{result.counts.known_hosts === 1 ? '' : 's'}.
          </p>
          <p className="transfer-path">{result.path}</p>
          <p className="form-hint">
            {result.secrets_included
              ? 'Passwords and private keys are inside, encrypted under the passphrase you chose. Anyone who has both the file and that passphrase has your credentials.'
              : 'No passwords or private keys are in this file. You will have to enter them again on the other machine.'}
          </p>
          <div className="modal-actions">
            <button className="btn-primary" onClick={onClose}>Done</button>
          </div>
        </>
      ) : (
        <>
          <div className="transfer-dest">
            <span className="transfer-path">{path || 'Choosing a folder…'}</span>
            <button className="btn-secondary btn-sm" onClick={() => setPicking(true)}>
              Choose…
            </button>
          </div>

          <label className="checkbox-row transfer-secrets">
            <input
              type="checkbox"
              checked={includeSecrets}
              onChange={(e) => setIncludeSecrets(e.target.checked)}
            />
            <span>Include saved passwords and private keys</span>
          </label>
          {!includeSecrets && (
            <p className="form-hint">
              Hosts, identities and key entries still travel, but without their secrets. Keys
              stored as a path on disk are references either way and are not copied.
            </p>
          )}

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
                placeholder="Passphrase for this file"
                onChange={(v) => { setPassphrase(v); setSaved(false); }}
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

          {!generated && (
            <PassphraseInput
              value={confirmPass}
              placeholder="Confirm passphrase"
              onChange={setConfirmPass}
            />
          )}

          {!generated && confirmPass.length > 0 && !matched && (
            <p className="form-hint" style={{ color: 'var(--danger)' }}>
              The two do not match.
            </p>
          )}

          {generated && (
            <div className="hostkey-warn">
              <strong>Write this down before continuing.</strong>
              <p>
                It is the only thing that opens the file, it is not stored anywhere, and it
                cannot be recovered. Capitals and spacing do not matter when you type it back.
              </p>
              <div className="setup-phrase-actions">
                <button type="button" className="btn-secondary" onClick={copy}>
                  {copied ? 'Copied' : 'Copy'}
                </button>
                <button
                  type="button"
                  className="link-btn"
                  onClick={() => {
                    setPassphrase('');
                    setConfirmPass('');
                    setGenerated(false);
                    setCopied(false);
                    setSaved(false);
                  }}
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

          {error && <p className="form-hint" style={{ color: 'var(--danger)' }}>{error}</p>}

          <div className="modal-actions">
            <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn-primary" onClick={() => run(overwrite)} disabled={!ready}>
              {busy ? 'Exporting…' : overwrite ? 'Replace file' : 'Export'}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
