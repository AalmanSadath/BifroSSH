import { useState } from 'react';
import { useAppStore } from '../store/appStore';
import type { Identity } from '../types';

export default function KeychainPanel() {
  const { keys, identities, importKey, saveKeyFromContent, deleteKey, saveIdentity, deleteIdentity } = useAppStore();

  const [showKeyForm, setShowKeyForm] = useState(false);
  const [keyInputMode, setKeyInputMode] = useState<'file' | 'paste'>('file');
  const [keyName, setKeyName] = useState('');
  const [keyPath, setKeyPath] = useState('');
  const [keyContent, setKeyContent] = useState('');
  const [keyPassphrase, setKeyPassphrase] = useState('');
  const [storeContent, setStoreContent] = useState(true);
  const [keyError, setKeyError] = useState('');
  const [savingKey, setSavingKey] = useState(false);

  const [showIdForm, setShowIdForm] = useState(false);
  const [editId, setEditId] = useState<Identity | null>(null);
  const [idName, setIdName] = useState('');
  const [idUsername, setIdUsername] = useState('');
  const [idKeyId, setIdKeyId] = useState('');
  const [idError, setIdError] = useState('');
  const [savingId, setSavingId] = useState(false);

  function resetKeyForm() {
    setKeyName(''); setKeyPath(''); setKeyContent(''); setKeyPassphrase('');
    setStoreContent(true); setKeyError(''); setKeyInputMode('file');
  }

  async function handleAddKey(e: React.FormEvent) {
    e.preventDefault();
    if (!keyName.trim()) { setKeyError('Name required'); return; }
    if (keyInputMode === 'file' && !keyPath.trim()) { setKeyError('File path required'); return; }
    if (keyInputMode === 'paste' && !keyContent.trim()) { setKeyError('Key content required'); return; }
    setSavingKey(true);
    setKeyError('');
    try {
      if (keyInputMode === 'paste') {
        await saveKeyFromContent(keyName.trim(), keyContent.trim(), keyPassphrase || null);
      } else {
        await importKey(keyName.trim(), keyPath.trim(), keyPassphrase || null, storeContent);
      }
      setShowKeyForm(false);
      resetKeyForm();
    } catch (err) {
      setKeyError(String(err));
    } finally {
      setSavingKey(false);
    }
  }

  function openAddIdentity() {
    setEditId(null);
    setIdName(''); setIdUsername(''); setIdKeyId(''); setIdError('');
    setShowIdForm(true);
  }

  function openEditIdentity(id: Identity) {
    setEditId(id);
    setIdName(id.name); setIdUsername(id.username); setIdKeyId(id.key_id); setIdError('');
    setShowIdForm(true);
  }

  async function handleSaveIdentity(e: React.FormEvent) {
    e.preventDefault();
    if (!idName.trim() || !idUsername.trim() || !idKeyId) { setIdError('All fields required'); return; }
    setSavingId(true);
    setIdError('');
    try {
      await saveIdentity({ id: editId?.id ?? '', name: idName.trim(), username: idUsername.trim(), key_id: idKeyId });
      setShowIdForm(false);
    } catch (err) {
      setIdError(String(err));
    } finally {
      setSavingId(false);
    }
  }

  return (
    <div className="panel">
      <div className="panel-title">Keychain</div>

      {/* Keys */}
      <section className="panel-section">
        <div className="panel-section-header">
          <h3>SSH Keys</h3>
          <button className="btn-primary btn-sm" onClick={() => { setShowKeyForm((v) => !v); if (showKeyForm) resetKeyForm(); }}>
            {showKeyForm ? 'Cancel' : '+ Add Key'}
          </button>
        </div>

        {showKeyForm && (
          <form className="inline-form" onSubmit={handleAddKey}>
            <div className="form-group">
              <label>Name</label>
              <input value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="My SSH Key" autoFocus />
            </div>

            <div className="form-group">
              <label>Input method</label>
              <div className="toggle-row">
                <button
                  type="button"
                  className={`toggle-btn${keyInputMode === 'file' ? ' active' : ''}`}
                  onClick={() => setKeyInputMode('file')}
                >
                  File path
                </button>
                <button
                  type="button"
                  className={`toggle-btn${keyInputMode === 'paste' ? ' active' : ''}`}
                  onClick={() => setKeyInputMode('paste')}
                >
                  Paste key
                </button>
              </div>
            </div>

            {keyInputMode === 'file' ? (
              <>
                <div className="form-group">
                  <label>Key file path</label>
                  <input value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="~/.ssh/id_ed25519" />
                </div>
                <label className="checkbox-row">
                  <input type="checkbox" checked={storeContent} onChange={(e) => setStoreContent(e.target.checked)} />
                  <span>Import and store key content (encrypted)</span>
                </label>
              </>
            ) : (
              <div className="form-group">
                <label>Key content</label>
                <textarea
                  className="key-paste-area"
                  value={keyContent}
                  onChange={(e) => setKeyContent(e.target.value)}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..."
                  rows={8}
                  spellCheck={false}
                />
              </div>
            )}

            <div className="form-group">
              <label>Passphrase (if encrypted)</label>
              <input type="password" value={keyPassphrase} onChange={(e) => setKeyPassphrase(e.target.value)} placeholder="leave empty if none" />
            </div>

            {keyError && <p className="form-error">{keyError}</p>}
            <div className="form-actions">
              <button type="button" className="btn-secondary btn-sm" onClick={() => { setShowKeyForm(false); resetKeyForm(); }}>Cancel</button>
              <button type="submit" className="btn-primary btn-sm" disabled={savingKey}>
                {savingKey ? 'Saving…' : 'Save Key'}
              </button>
            </div>
          </form>
        )}

        <ul className="item-list">
          {keys.map((key) => (
            <li key={key.id} className="item-row">
              <div className="item-info">
                <span className="item-name">{key.name}</span>
                <span className="item-detail">
                  {key.encrypted_key === '[stored]' ? 'encrypted storage' : key.key_path}
                  {key.encrypted_passphrase === '[stored]' && ' · passphrase saved'}
                </span>
              </div>
              <button className="action-btn danger" onClick={() => deleteKey(key.id)} title="Delete">✕</button>
            </li>
          ))}
          {keys.length === 0 && <li className="list-empty">No keys added yet.</li>}
        </ul>
      </section>

      {/* Identities */}
      <section className="panel-section">
        <div className="panel-section-header">
          <h3>Identities</h3>
          <button
            className="btn-primary btn-sm"
            onClick={openAddIdentity}
          >
            + Add Identity
          </button>
        </div>

        {showIdForm && (
          <form className="inline-form" onSubmit={handleSaveIdentity}>
            <div className="form-group">
              <label>Name</label>
              <input value={idName} onChange={(e) => setIdName(e.target.value)} placeholder="prod-ubuntu" autoFocus />
            </div>
            <div className="form-group">
              <label>Username</label>
              <input value={idUsername} onChange={(e) => setIdUsername(e.target.value)} placeholder="ubuntu" />
            </div>
            <div className="form-group">
              <label>Key</label>
              <select value={idKeyId} onChange={(e) => setIdKeyId(e.target.value)}>
                <option value="">Select key…</option>
                {keys.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
              </select>
              {keys.length === 0 && (
                <p className="form-hint">No keys yet — add one in the SSH Keys section above.</p>
              )}
            </div>
            {idError && <p className="form-error">{idError}</p>}
            <div className="form-actions">
              <button type="button" className="btn-secondary btn-sm" onClick={() => setShowIdForm(false)}>Cancel</button>
              <button type="submit" className="btn-primary btn-sm" disabled={savingId}>
                {savingId ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        )}

        <ul className="item-list">
          {identities.map((id) => {
            const key = keys.find((k) => k.id === id.key_id);
            return (
              <li key={id.id} className={`item-row${!key ? ' item-row-warn' : ''}`}>
                <div className="item-info">
                  <span className="item-name">{id.name}</span>
                  <span className="item-detail">
                    {id.username} · {key ? key.name : <span className="warn-text">key deleted — edit to fix</span>}
                  </span>
                </div>
                <div className="item-row-actions">
                  <button className="action-btn" onClick={() => openEditIdentity(id)} title="Edit">✎</button>
                  <button className="action-btn danger" onClick={() => deleteIdentity(id.id)} title="Delete">✕</button>
                </div>
              </li>
            );
          })}
          {identities.length === 0 && <li className="list-empty">No identities. Add a key first.</li>}
        </ul>
      </section>
    </div>
  );
}
