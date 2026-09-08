import { useEffect, useState } from 'react';
import * as ipc from '../ipc';
import { useAppStore } from '../store/appStore';
import type { SshConfigHost, SshConfigScan, SshConfigImportResult } from '../types';
import Modal from './shared/Modal';

interface Props {
  onClose: () => void;
}

export default function SshConfigImport({ onClose }: Props) {
  const { loadAll } = useAppStore();
  const [scan, setScan] = useState<SshConfigScan | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SshConfigImportResult | null>(null);

  useEffect(() => {
    ipc.scanSshConfig()
      .then((s) => {
        setScan(s);
        // Everything preselected: the user is here because they want them.
        setSelected(new Set(s.hosts.map((h) => h.alias)));
      })
      .catch((e) => setError(String(e)));
  }, []);

  function toggle(alias: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(alias)) next.delete(alias);
      else next.add(alias);
      return next;
    });
  }

  async function runImport() {
    setBusy(true);
    setError('');
    try {
      const res = await ipc.importSshConfigHosts([...selected]);
      setResult(res);
      await loadAll();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const describe = (h: SshConfigHost) => {
    const target = h.port && h.port !== 22 ? `${h.hostname}:${h.port}` : h.hostname;
    return h.user ? `${h.user}@${target}` : target;
  };

  return (
    <Modal title="Import from ssh config" subtitle="Your OpenSSH config" onClose={onClose}>
      {error && <p className="form-hint form-hint-error">{error}</p>}

      {result ? (
        <>
          <p className="hostkey-body">
            Imported {result.imported} host{result.imported === 1 ? '' : 's'}.
            {result.keys_linked > 0 && ` Linked ${result.keys_linked} key file${result.keys_linked === 1 ? '' : 's'}.`}
            {result.jumps_linked > 0 && ` Linked ${result.jumps_linked} jump host${result.jumps_linked === 1 ? '' : 's'}.`}
            {result.skipped_existing > 0 && ` Skipped ${result.skipped_existing} already saved.`}
          </p>
          <div className="modal-actions">
            <button className="btn-primary" onClick={onClose}>Done</button>
          </div>
        </>
      ) : !scan ? (
        <p className="form-hint">Reading your OpenSSH config…</p>
      ) : scan.hosts.length === 0 ? (
        <>
          <p className="hostkey-body">No importable hosts found in your OpenSSH config.</p>
          <div className="modal-actions">
            <button className="btn-secondary" onClick={onClose}>Close</button>
          </div>
        </>
      ) : (
        <>
          {scan.unreadable_includes.length > 0 && (
            <p className="form-hint form-hint-warn">
              {scan.unreadable_includes.length === 1 ? 'This file was' : 'These files were'}{' '}
              named by <code>Include</code> and could not be read, so hosts defined in{' '}
              {scan.unreadable_includes.length === 1 ? 'it' : 'them'} are missing:{' '}
              {scan.unreadable_includes.join(', ')}
            </p>
          )}

          {scan.included_files.length > 0 && (
            <p className="form-hint">
              Following <code>Include</code> added {scan.included_files.length}{' '}
              {scan.included_files.length === 1 ? 'file' : 'files'} to this list.
            </p>
          )}

          <div className="checklist">
            {scan.hosts.map((h) => (
              <label className="checklist-row" key={h.alias}>
                <input
                  type="checkbox"
                  checked={selected.has(h.alias)}
                  onChange={() => toggle(h.alias)}
                />
                <span className="sshconfig-alias">{h.alias}</span>
                <span className="sshconfig-target">{describe(h)}</span>
                {h.identity_file && <span className="checklist-tag">key</span>}
                {h.proxy_jump && (
                  <span
                    className="checklist-tag"
                    title={`Reached through ${h.proxy_jump}. Every hop has to be imported in the same run for the link to be made.`}
                  >
                    jump
                  </span>
                )}
              </label>
            ))}
          </div>

          <p className="form-hint">
            Key files are referenced where they are, not copied into the keychain. Hosts that
            already exist are skipped. A jump host is linked only when it is imported in the
            same run.
          </p>

          <div className="modal-actions">
            <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
            <button
              className="btn-primary"
              onClick={runImport}
              disabled={busy || selected.size === 0}
            >
              {busy ? 'Importing…' : `Import ${selected.size}`}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
