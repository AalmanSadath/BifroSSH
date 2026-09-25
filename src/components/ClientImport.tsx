import { useState } from 'react';
import * as ipc from '../ipc';
import { localStyle } from '../paths';
import { useAppStore } from '../store/appStore';
import type { ClientImportResult, ClientScan, ImportSource, ScannedHost } from '../types';
import FilePickerModal from './FilePickerModal';
import Modal from './shared/Modal';

interface Props {
  onClose: () => void;
}

const SOURCE_NAMES: Record<ImportSource, string> = {
  termius: 'Termius',
  putty: 'PuTTY',
  moba_xterm: 'MobaXterm',
};

/**
 * Creates hosts from another client's export.
 *
 * A row already saved under the same address, port and user starts unticked:
 * importing it again would only make a second copy of a host the user already
 * has, and that is worth showing rather than hiding.
 */
export default function ClientImport({ onClose }: Props) {
  const { loadAll } = useAppStore();
  const [path, setPath] = useState('');
  const [picking, setPicking] = useState(true);
  const [scan, setScan] = useState<ClientScan | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [withPasswords, setWithPasswords] = useState(true);
  const [result, setResult] = useState<ClientImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function read(file: string) {
    setBusy(true);
    setError('');
    try {
      const found = await ipc.scanClientExport(file);
      setScan(found);
      // Everything the user does not already have: they are here to add hosts.
      setPicked(new Set(found.hosts.flatMap((h, i) => (h.already_here ? [] : [i]))));
    } catch (e) {
      setScan(null);
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function toggle(index: number) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  async function runImport() {
    if (!scan) return;
    setBusy(true);
    setError('');
    try {
      const res = await ipc.importClientHosts(path, [...picked], scan.hosts.length, withPasswords);
      setResult(res);
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
        title="Choose an exported list of hosts"
        startDir={localStyle().parent(path) ?? undefined}
        extensions={['.csv', '.reg', '.mxtsessions', '.ini']}
        onCancel={() => (scan ? setPicking(false) : onClose())}
        onChoose={(file) => {
          setPath(file);
          setPicking(false);
          void read(file);
        }}
      />
    );
  }

  const describe = (h: ScannedHost) => {
    const target = h.port === 22 ? h.host : `${h.host}:${h.port}`;
    return h.username ? `${h.username}@${target}` : target;
  };
  const passwordRows = scan?.hosts.filter((h) => h.has_password).length ?? 0;
  const source = scan ? SOURCE_NAMES[scan.source] : '';

  return (
    <Modal
      title="Import from another client"
      subtitle={scan ? `${source} · ${path}` : path}
      onClose={onClose}
    >
      {error && <p className="form-hint form-hint-error">{error}</p>}

      {result ? (
        <>
          <p className="hostkey-body">
            Imported {result.imported} host{result.imported === 1 ? '' : 's'}.
            {result.groups_created > 0 && ` Added ${result.groups_created} group${result.groups_created === 1 ? '' : 's'}.`}
            {result.passwords_saved > 0 && ` Saved ${result.passwords_saved} password${result.passwords_saved === 1 ? '' : 's'}.`}
            {result.skipped_existing > 0 && ` Skipped ${result.skipped_existing} already saved.`}
          </p>
          {result.passwords_saved > 0 && (
            <p className="form-hint form-hint-warn">
              Those passwords are now encrypted here, but they are still in plain text in{' '}
              {path}. Delete that file.
            </p>
          )}
          <div className="modal-actions">
            <button className="btn-primary" onClick={onClose}>Done</button>
          </div>
        </>
      ) : busy && !scan ? (
        <p className="form-hint">Reading the file…</p>
      ) : !scan ? (
        <div className="modal-actions">
          <button className="btn-secondary" onClick={onClose}>Close</button>
          <button className="btn-primary" onClick={() => setPicking(true)}>Choose another file</button>
        </div>
      ) : scan.hosts.length === 0 ? (
        <>
          <p className="hostkey-body">There are no ssh hosts in this file.</p>
          {scan.skipped.length > 0 && <Skipped lines={scan.skipped} />}
          <div className="modal-actions">
            <button className="btn-secondary" onClick={onClose}>Close</button>
            <button className="btn-primary" onClick={() => setPicking(true)}>Choose another file</button>
          </div>
        </>
      ) : (
        <>
          <div className="checklist">
            {scan.hosts.map((h, i) => (
              <label className="checklist-row" key={`${h.host}:${h.port}:${h.name}:${i}`}>
                <input type="checkbox" checked={picked.has(i)} onChange={() => toggle(i)} />
                <span className="sshconfig-alias">{h.name}</span>
                <span className="sshconfig-target">{describe(h)}</span>
                {h.group && <span className="checklist-tag">{h.group}</span>}
                {h.has_password && <span className="checklist-tag">password</span>}
                {h.already_here && (
                  <span
                    className="checklist-tag"
                    title="A saved host already has this address, port and user. Importing it again would make a second copy."
                  >
                    already saved
                  </span>
                )}
              </label>
            ))}
          </div>

          {scan.skipped.length > 0 && <Skipped lines={scan.skipped} />}

          {passwordRows > 0 && (
            <>
              <p className="form-hint form-hint-warn">
                {passwordRows === 1 ? 'One host in' : `${passwordRows} hosts in`} this file{' '}
                {passwordRows === 1 ? 'carries its password' : 'carry their passwords'} in plain
                text. Whatever you choose here, that file is readable by anything running as you:
                delete it once you are done. Saved here, a password is encrypted with your master
                key like any other.
              </p>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={withPasswords}
                  onChange={(e) => setWithPasswords(e.target.checked)}
                />
                <span>
                  Save {passwordRows === 1 ? 'that password' : 'those passwords'} too
                </span>
              </label>
            </>
          )}

          <p className="form-hint">
            A host already saved under the same address, port and user is skipped, so the same
            file can be imported twice. Folders become groups. Keys are not imported: point each
            host at one in its settings, or import the key file itself in the Keychain.
          </p>

          <div className="modal-actions">
            <button className="btn-secondary" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn-secondary" onClick={() => setPicking(true)} disabled={busy}>
              Choose another file
            </button>
            <button className="btn-primary" onClick={runImport} disabled={busy || picked.size === 0}>
              {busy ? 'Importing…' : `Import ${picked.size}`}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

/** What the file held that is not an ssh host, so nothing appears to be lost. */
function Skipped({ lines }: { lines: string[] }) {
  return (
    <p className="form-hint">
      Not offered: {lines.join('; ')}.
    </p>
  );
}
