import { useEffect, useRef, useState } from 'react';
import AutoTextarea from './shared/AutoTextarea';
import { useCopy } from './shared/useCopy';
import * as ipc from '../ipc';
import type { CertInfo } from '../types';

interface Props {
  /** The certificate text as edited, saved with the rest of the key. */
  value: string;
  onChange: (text: string) => void;
  /** The private key as it stands in the form, to check the certificate against. */
  keyPem: string;
  passphrase: string;
  /**
   * The saved key, when editing one: with the field empty, a key kept by
   * path shows the certificate beside its file, the one a connect uses.
   */
  keyId?: string;
  /**
   * Told what is wrong with the certificate, or '' when nothing is, so the
   * form can hold back its save: the reason is already shown here, and a
   * save would only come back with it a second time.
   */
  onProblem?: (problem: string) => void;
}

/** Whether a certificate can be used now, by its validity window. */
function certStatus(info: CertInfo, now = Date.now() / 1000): 'valid' | 'expired' | 'not-yet' {
  if (now < info.valid_after) return 'not-yet';
  if (info.valid_before !== null && now >= info.valid_before) return 'expired';
  return 'valid';
}

const when = (secs: number) => new Date(secs * 1000).toLocaleString();

/**
 * A key's OpenSSH certificate in the key forms: what it says, and the text
 * itself to edit, paste over or clear.
 *
 * Checked against the key as it is typed, so a certificate for another key,
 * or a host certificate, says so at once, with a Clear beside it, rather
 * than only when the form is saved. The backend checks again on save.
 */
export default function KeyCertificate({ value, onChange, keyPem, passphrase, keyId, onProblem }: Props) {
  const [info, setInfo] = useState<CertInfo | null>(null);
  const [besideFile, setBesideFile] = useState(false);
  const [problem, setProblem] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const { copied, copy } = useCopy();

  useEffect(() => {
    let live = true;
    const text = value.trim();
    setProblem('');
    if (text === '') {
      setInfo(null);
      setBesideFile(false);
      if (keyId) {
        ipc.inspectKeyCertificate(keyId)
          .then((i) => { if (live) { setInfo(i); setBesideFile(i !== null); } })
          .catch(() => {});
      }
      return () => { live = false; };
    }
    if (keyPem.trim() === '') {
      setInfo(null);
      return () => { live = false; };
    }
    // A pause in typing, not a check per keystroke.
    const timer = setTimeout(() => {
      ipc.checkCertificate(text, keyPem, passphrase || null)
        .then((i) => { if (live) { setInfo(i); setBesideFile(false); } })
        .catch((e) => { if (live) { setInfo(null); setProblem(String(e)); } });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [value, keyPem, passphrase, keyId]);

  useEffect(() => { onProblem?.(problem); }, [problem, onProblem]);

  function fromFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => onChange((ev.target?.result as string).trim());
    reader.readAsText(file);
    e.target.value = '';
  }

  const status = info ? certStatus(info) : null;

  return (
    <div className="form-group">
      <label>Certificate (optional)</label>
      {info && (
        <div className="key-cert">
          <div className="key-cert-row">
            <span className="key-cert-id">{info.key_id || 'No key ID'}</span>
            {status === 'expired' && <span className="key-cert-badge bad">Expired</span>}
            {status === 'not-yet' && <span className="key-cert-badge warn">Not yet valid</span>}
          </div>
          <div className="key-cert-detail">
            For {info.principals.length > 0 ? info.principals.join(', ') : 'any user'}
            {' · '}
            {info.valid_before === null ? 'never expires' : `valid until ${when(info.valid_before)}`}
          </div>
          <div className="key-cert-detail key-cert-ca" title="The certificate authority that signed it">
            CA {info.ca_fingerprint}
          </div>
          {besideFile && (
            <p className="form-hint">Found beside the key file, as OpenSSH looks for it; used at connect.</p>
          )}
          {info.rsa && (
            <p className="form-hint form-hint-warn">
              This is an RSA certificate. This app offers it under the old ssh-rsa-cert-v01 name, which
              OpenSSH 8.8 and later refuse by default. An Ed25519 or ECDSA key&apos;s certificate works everywhere.
            </p>
          )}
        </div>
      )}
      {/* Framed with a Copy under it when editing a key, the way the
          private key above it is; the add form has neither on its key. */}
      {keyId ? (
        <div className="key-pub-box key-pub-box--tall">
          <AutoTextarea
            className="key-paste-area key-cert-area"
            value={value}
            onChange={onChange}
            placeholder="ssh-ed25519-cert-v01@openssh.com AAAA…  (the key's -cert.pub)"
          />
          <button type="button" className="btn-secondary btn-sm" disabled={value.trim() === ''} onClick={() => void copy(value.trim())}>
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      ) : (
        <AutoTextarea
          className="key-paste-area key-cert-area"
          value={value}
          onChange={onChange}
          placeholder="ssh-ed25519-cert-v01@openssh.com AAAA…  (the key's -cert.pub)"
        />
      )}
      <input ref={fileRef} type="file" accept=".pub,*" style={{ display: 'none' }} onChange={fromFile} />
      <div className="key-cert-actions">
        <button type="button" className="btn-secondary btn-sm" onClick={() => fileRef.current?.click()}>
          Import certificate file
        </button>
        {problem && (
          <button type="button" className="btn-secondary btn-sm key-cert-clear" onClick={() => onChange('')}>
            Clear
          </button>
        )}
      </div>
      {problem && <p className="form-error">{problem}</p>}
      {!info && !problem && value.trim() === '' && (
        <p className="form-hint">
          A certificate signed by a CA the server trusts lets this key in without an
          authorized_keys line.
        </p>
      )}
    </div>
  );
}
