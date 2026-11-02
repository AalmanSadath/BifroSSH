import { useState, useRef } from 'react';
import * as ipc from '../ipc';
import { useAppStore } from '../store/appStore';
import type { KeyEntry } from '../types';
import { useCopy } from './shared/useCopy';
import KeyCertificate from './KeyCertificate';
import AutoTextarea from './shared/AutoTextarea';
import Drawer from './shared/Drawer';
import PassphraseInput from './shared/PassphraseInput';

const KEY_ALGORITHMS = [
  { value: 'ed25519', label: 'ED25519' },
  { value: 'ecdsa-p256', label: 'ECDSA (P-256)' },
  { value: 'rsa', label: 'RSA' },
];

const RSA_SIZES = [2048, 4096];

/**
 * The drawer that adds an SSH key, by importing one or generating one.
 *
 * Its own component so a form that needs a key can open it on top of itself
 * and carry on: the host and identity forms stay mounted underneath with
 * whatever was typed into them, and `onSaved` hands back the new key for them
 * to select. The Keychain opens the same drawer from its own buttons.
 *
 * Each opening starts empty, so there is nothing to reset on close.
 */
export default function KeyCreateDrawer({ mode, onClose, onSaved }: {
  mode: 'import' | 'generate';
  onClose: () => void;
  onSaved?: (key: KeyEntry) => void;
}) {
  return mode === 'import'
    ? <ImportKeyDrawer onClose={onClose} onSaved={onSaved} />
    : <GenerateKeyDrawer onClose={onClose} onSaved={onSaved} />;
}

type DrawerProps = { onClose: () => void; onSaved?: (key: KeyEntry) => void };

function ImportKeyDrawer({ onClose, onSaved }: DrawerProps) {
  const saveKeyFromContent = useAppStore((s) => s.saveKeyFromContent);
  const [keyName, setKeyName] = useState('');
  const [keyContent, setKeyContent] = useState('');
  const [keyCert, setKeyCert] = useState('');
  /** What the certificate field says is wrong; the save waits until it is fixed or cleared. */
  const [certProblem, setCertProblem] = useState('');
  const [keyPassphrase, setKeyPassphrase] = useState('');
  const [keyError, setKeyError] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const keyFileInputRef = useRef<HTMLInputElement>(null);

  function handleKeyFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = (ev.target?.result as string).trim();
      if (!keyName.trim()) setKeyName(file.name.replace(/\.(ppk|pem|key|txt)$/i, ''));
      setKeyContent(text);
      setKeyError('');
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  async function handleAddKey(e: React.FormEvent) {
    e.preventDefault();
    if (!keyName.trim()) { setKeyError('Name required'); return; }
    if (!keyContent.trim()) { setKeyError('Key content required'); return; }
    if (certProblem) return;
    setSavingKey(true);
    setKeyError('');
    try {
      let content = keyContent.trim();
      let passphraseToStore: string | null = keyPassphrase || null;
      if (content.startsWith('PuTTY-User-Key-File')) {
        content = await ipc.convertPpk(content, keyPassphrase || null);
        passphraseToStore = null;
      }
      const key = await saveKeyFromContent(keyName.trim(), content, passphraseToStore, keyCert.trim() || null);
      onSaved?.(key);
      onClose();
    } catch (err) {
      setKeyError(String(err));
    } finally {
      setSavingKey(false);
    }
  }

  return (
    <Drawer
      title="Add SSH Key"
      onClose={onClose}
      action={
        <button type="submit" form="key-form" className="btn-primary btn-sm" disabled={savingKey || !!certProblem}>
          {savingKey ? 'Saving…' : 'Save Key'}
        </button>
      }
    >
      <div className="drawer-body">
        <form id="key-form" className="inline-form" onSubmit={handleAddKey}>
          <div className="form-group">
            <label>Name</label>
            <input value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="My SSH Key" autoFocus />
          </div>
          <div className="form-group">
            <label>Private key</label>
            <AutoTextarea
              className="key-paste-area"
              value={keyContent}
              onChange={setKeyContent}
              placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n...'}
              rows={8}
            />
            <input
              ref={keyFileInputRef}
              type="file"
              accept=".ppk,.pem,.key,.txt,*"
              style={{ display: 'none' }}
              onChange={handleKeyFileSelect}
            />
            <button
              type="button"
              className="btn-secondary btn-sm self-start"
              onClick={() => keyFileInputRef.current?.click()}
            >
              Import from key file
            </button>
          </div>
          <div className="form-group">
            <label>Passphrase (if encrypted)</label>
            <PassphraseInput
              value={keyPassphrase}
              onChange={setKeyPassphrase}
              placeholder="leave empty if none"
            />
          </div>
          <KeyCertificate
            value={keyCert}
            onChange={setKeyCert}
            keyPem={keyContent}
            passphrase={keyPassphrase}
            onProblem={setCertProblem}
          />
          {keyContent.trimStart().startsWith('PuTTY-User-Key-File') && (
            <p className="form-info">PPK file will be converted to OpenSSH format on save.</p>
          )}
          {keyError && <p className="form-error">{keyError}</p>}
        </form>
      </div>
    </Drawer>
  );
}

function GenerateKeyDrawer({ onClose, onSaved }: DrawerProps) {
  const { saveKeyFromContent, generateKey } = useAppStore();
  const { copied, copy } = useCopy();
  const [genKeyName, setGenKeyName] = useState('');
  const [genKeyError, setGenKeyError] = useState('');
  const [genSaving, setGenSaving] = useState(false);
  const [genAlgorithm, setGenAlgorithm] = useState('ed25519');
  const [rsaSize, setRsaSize] = useState(4096);
  const [genResult, setGenResult] = useState<{ private_pem: string; public_openssh: string } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genPassphrase, setGenPassphrase] = useState('');

  async function handleGenerate() {
    setGenerating(true);
    setGenKeyError('');
    setGenResult(null);
    try {
      const algoArg = genAlgorithm === 'rsa' ? `rsa-${rsaSize}` : genAlgorithm;
      const result = await generateKey(algoArg, genPassphrase || null);
      setGenResult(result);
    } catch (err) {
      setGenKeyError(String(err));
    } finally {
      setGenerating(false);
    }
  }

  async function handleSaveGenerated(e: React.FormEvent) {
    e.preventDefault();
    if (!genKeyName.trim()) { setGenKeyError('Name required'); return; }
    if (!genResult) { setGenKeyError('Generate a key first'); return; }
    setGenSaving(true);
    setGenKeyError('');
    try {
      const key = await saveKeyFromContent(genKeyName.trim(), genResult.private_pem, genPassphrase || null);
      onSaved?.(key);
      onClose();
    } catch (err) {
      setGenKeyError(String(err));
    } finally {
      setGenSaving(false);
    }
  }

  return (
    <Drawer
      title="Generate SSH Key"
      onClose={onClose}
      action={
        <button type="submit" form="gen-key-form" className="btn-primary btn-sm" disabled={genSaving || !genResult}>
          {genSaving ? 'Saving…' : 'Save Key'}
        </button>
      }
    >
      <div className="drawer-body">
        <form id="gen-key-form" className="inline-form" onSubmit={handleSaveGenerated}>
          <div className="form-group">
            <label>Name</label>
            <input value={genKeyName} onChange={(e) => setGenKeyName(e.target.value)} placeholder="My Generated Key" autoFocus />
          </div>
          <div className="form-group">
            <label>Passphrase (optional)</label>
            <PassphraseInput
              value={genPassphrase}
              onChange={setGenPassphrase}
              placeholder="leave empty for no passphrase"
            />
          </div>
          <div className="form-group">
            <label>Algorithm</label>
            <div className="toggle-row">
              {KEY_ALGORITHMS.map((alg) => (
                <button
                  key={alg.value}
                  type="button"
                  className={`toggle-btn${genAlgorithm === alg.value ? ' active' : ''}`}
                  onClick={() => { setGenAlgorithm(alg.value); setGenResult(null); }}
                >
                  {alg.label}
                </button>
              ))}
            </div>
          </div>
          {genAlgorithm === 'rsa' && (
            <div className="form-group">
              <label>Key size</label>
              <div className="toggle-row">
                {RSA_SIZES.map((size) => (
                  <button
                    key={size}
                    type="button"
                    className={`toggle-btn${rsaSize === size ? ' active' : ''}`}
                    onClick={() => { setRsaSize(size); setGenResult(null); }}
                  >
                    {size}
                  </button>
                ))}
              </div>
            </div>
          )}
          <button
            type="button"
            className="btn-secondary btn-sm self-start"
            onClick={handleGenerate}
            disabled={generating}
          >
            {generating ? 'Generating…' : genResult ? 'Regenerate' : 'Generate Key'}
          </button>
          {genResult && (
            <>
              <div className="form-group">
                <label>Public key: add this to your server's authorized_keys</label>
                <div className="key-pub-box">
                  <code>{genResult.public_openssh}</code>
                  <button type="button" className="btn-secondary btn-sm" onClick={() => void copy(genResult!.public_openssh, 'gen-pub')}>{copied === 'gen-pub' ? 'Copied' : 'Copy'}</button>
                </div>
              </div>
              <div className="form-group">
                <label>Private key</label>
                <div className="key-pub-box">
                  <code>{genResult.private_pem}</code>
                  <button type="button" className="btn-secondary btn-sm" onClick={() => void copy(genResult!.private_pem, 'gen-key')}>{copied === 'gen-key' ? 'Copied' : 'Copy'}</button>
                </div>
              </div>
            </>
          )}
          {genKeyError && <p className="form-error">{genKeyError}</p>}
        </form>
      </div>
    </Drawer>
  );
}
