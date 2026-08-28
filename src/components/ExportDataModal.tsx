import { useEffect, useState } from 'react';
import * as ipc from '../ipc';
import { localStyle } from '../paths';
import PassphraseInput from './shared/PassphraseInput';
import GeneratedPassphraseField from './shared/GeneratedPassphraseField';
import FilePickerModal from './FilePickerModal';
import { describeCounts } from '../types';
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
  const [saved, setSaved] = useState(false);
  const [includeSecrets, setIncludeSecrets] = useState(true);
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ExportResult | null>(null);

  useEffect(() => {
    ipc.defaultExportDir()
      .then((d) => {
        setDir(d);
        setPath(localStyle().join(d, defaultName()));
      })
      .catch((e) => setError(String(e)));
  }, []);



  const matched = passphrase.length > 0 && passphrase === confirmPass;
  // A generated phrase is nowhere but the screen until the user says otherwise.
  const ready = Boolean(path) && matched && (!generated || saved) && !busy;

  async function run(force: boolean) {
    setBusy(true);
    setError('');
    try {
      const res = await ipc.exportData(path, passphrase, includeSecrets, force);
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
        startDir={localStyle().parent(path) ?? dir}
        defaultName={localStyle().basename(path) || defaultName()}
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
          <p className="hostkey-body">Wrote {describeCounts(result.counts)}.</p>
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

          <GeneratedPassphraseField
            passphrase={passphrase}
            onChange={(v, gen) => { setPassphrase(v); setGenerated(gen); }}
            generated={generated}
            saved={saved}
            onSavedChange={setSaved}
            placeholder="Passphrase for this file"
            onError={setError}
            onReset={() => setConfirmPass('')}
            warning={
              <p>
                It is the only thing that opens the file, it is not stored anywhere, and it
                cannot be recovered. Capitals and spacing do not matter when you type it back.
              </p>
            }
          />

          {!generated && (
            <PassphraseInput
              value={confirmPass}
              placeholder="Confirm passphrase"
              onChange={setConfirmPass}
            />
          )}

          {!generated && confirmPass.length > 0 && !matched && (
            <p className="form-hint form-hint-error">
              The two do not match.
            </p>
          )}


          {error && <p className="form-hint form-hint-error">{error}</p>}

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
