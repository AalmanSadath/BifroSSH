import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import PassphraseInput from './shared/PassphraseInput';
import FilePickerModal from './FilePickerModal';
import { useAppStore } from '../store/appStore';
import type { ImportOptions, ImportReport, MergePlan, TransferCounts } from '../types';
import Modal from './shared/Modal';

interface Props {
  onClose: () => void;
}

type Category = keyof ImportOptions;

const CATEGORIES: { id: Category; label: string; counts?: keyof TransferCounts }[] = [
  { id: 'servers', label: 'Hosts', counts: 'servers' },
  { id: 'identities', label: 'Identities', counts: 'identities' },
  { id: 'keys', label: 'Keys', counts: 'keys' },
  { id: 'port_forwardings', label: 'Tunnels', counts: 'port_forwardings' },
  { id: 'codeprints', label: 'Codeprints', counts: 'codeprints' },
  { id: 'custom_themes', label: 'Themes', counts: 'custom_themes' },
  { id: 'known_hosts', label: 'Known hosts', counts: 'known_hosts' },
  { id: 'settings', label: 'Settings' },
];

/**
 * Merges an exported file into this install.
 *
 * Nothing is ever replaced: anything already here wins, so the same file can
 * be imported twice with no effect, and a stale export cannot undo newer local
 * edits. Settings are the one wholesale overwrite, and are off by default.
 */
export default function ImportDataModal({ onClose }: Props) {
  const { loadAll } = useAppStore();
  const [path, setPath] = useState('');
  const [picking, setPicking] = useState(false);
  const [passphrase, setPassphrase] = useState('');
  const [plan, setPlan] = useState<MergePlan | null>(null);
  const [chosen, setChosen] = useState<ImportOptions | null>(null);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function preview() {
    setBusy(true);
    setError('');
    try {
      const p = await invoke<MergePlan>('preview_import', { path, passphrase });
      setPlan(p);
      setChosen({
        servers: p.incoming.servers > 0,
        identities: p.incoming.identities > 0,
        keys: p.incoming.keys > 0,
        port_forwardings: p.incoming.port_forwardings > 0,
        codeprints: p.incoming.codeprints > 0,
        custom_themes: p.incoming.custom_themes > 0,
        known_hosts: p.incoming.known_hosts > 0,
        // The only wholesale overwrite in here, so it is opted into.
        settings: false,
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function run() {
    if (!chosen) return;
    setBusy(true);
    setError('');
    try {
      const res = await invoke<ImportReport>('import_data', {
        path,
        passphrase,
        options: chosen,
      });
      setReport(res);
      await loadAll();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (picking) {
    return (
      <FilePickerModal
        mode="open"
        title="Choose an export file"
        startDir={path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : undefined}
        extensions={['.bfx']}
        onCancel={() => setPicking(false)}
        onChoose={(file) => {
          setPath(file);
          setError('');
          setPicking(false);
        }}
      />
    );
  }

  const total = (counts: TransferCounts) =>
    Object.values(counts).reduce((sum, n) => sum + n, 0);

  return (
    <Modal
      className="transfer-modal"
      title="Import settings"
      subtitle="Adds what is missing. Nothing here is replaced."
      onClose={onClose}
    >
      {report ? (
        <>
          <p className="hostkey-body">
            Added {total(report.added)} item{total(report.added) === 1 ? '' : 's'} and skipped{' '}
            {total(report.skipped)} already here.
            {report.settings_replaced && ' Settings were replaced.'}
          </p>
          {report.unresolved_refs > 0 && (
            <p className="form-hint">
              {report.unresolved_refs} link{report.unresolved_refs === 1 ? '' : 's'} pointed at
              something that was not imported and {report.unresolved_refs === 1 ? 'was' : 'were'}{' '}
              cleared. Check the affected hosts for a missing identity, key or jump host.
            </p>
          )}
          {report.host_key_conflicts.length > 0 && (
            <div className="hostkey-warn">
              <strong>Host keys left alone</strong>
              <p>
                The file names a different key than the one already recorded for these hosts.
                Nothing was changed: a host whose key really has changed should be confirmed
                through the mismatch prompt on the next connect, not through a file.
              </p>
              <ul className="transfer-conflicts">
                {report.host_key_conflicts.map((h) => <li key={h}>{h}</li>)}
              </ul>
            </div>
          )}
          <div className="modal-actions">
            <button className="btn-primary" onClick={onClose}>Done</button>
          </div>
        </>
      ) : plan && chosen ? (
        <>
          <p className="transfer-path">{path}</p>
          <p className="form-hint">
            Made {new Date(plan.created * 1000).toLocaleString()} by BifroSSH {plan.app_version}.
            {plan.secrets_included
              ? ' Passwords and private keys are included.'
              : ' No passwords or private keys are in this file.'}
          </p>

          <div className="transfer-list">
            {CATEGORIES.map((cat) => {
              const incoming = cat.counts ? plan.incoming[cat.counts] : plan.has_settings ? 1 : 0;
              const dup = cat.counts ? plan.duplicates[cat.counts] : 0;
              const disabled = incoming === 0;
              return (
                <label
                  key={cat.id}
                  className={`transfer-row${disabled ? ' transfer-row-empty' : ''}`}
                >
                  <input
                    type="checkbox"
                    checked={chosen[cat.id]}
                    disabled={disabled}
                    onChange={(e) => setChosen({ ...chosen, [cat.id]: e.target.checked })}
                  />
                  <span className="transfer-count">{cat.counts ? incoming : ''}</span>
                  <span className="transfer-label">{cat.label}</span>
                  {cat.id === 'settings' && plan.has_settings && (
                    <span className="transfer-note transfer-note-warn">overwrites yours</span>
                  )}
                  {dup > 0 && <span className="transfer-note">{dup} already here, skipped</span>}
                </label>
              );
            })}
          </div>

          {plan.missing_key_paths.length > 0 && (
            <p className="form-hint">
              {plan.missing_key_paths.length} key entr
              {plan.missing_key_paths.length === 1 ? 'y points' : 'ies point'} at a file this
              machine does not have ({plan.missing_key_paths.join(', ')}). They will import, but
              will not work until the file is there or the key is re-added.
            </p>
          )}

          {error && <p className="form-hint" style={{ color: 'var(--danger)' }}>{error}</p>}

          <div className="modal-actions">
            <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
            <button
              className="btn-primary"
              onClick={run}
              disabled={busy || !Object.values(chosen).some(Boolean)}
            >
              {busy ? 'Importing…' : 'Import'}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="transfer-dest">
            <span className="transfer-path">{path || 'No file chosen'}</span>
            <button className="btn-secondary btn-sm" onClick={() => setPicking(true)}>
              Choose…
            </button>
          </div>

          <PassphraseInput
            value={passphrase}
            placeholder="Passphrase for this file"
            autoComplete="current-password"
            onChange={setPassphrase}
          />

          {error && <p className="form-hint" style={{ color: 'var(--danger)' }}>{error}</p>}

          <div className="modal-actions">
            <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
            <button
              className="btn-primary"
              onClick={preview}
              disabled={busy || !path || !passphrase}
            >
              {busy ? 'Opening…' : 'Open'}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
