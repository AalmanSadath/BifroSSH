import { useState } from 'react';
import { useAppStore } from '../store/appStore';
import type { Identity } from '../types';

const KEY_ALGORITHMS = [
  { value: 'ed25519', label: 'ED25519', supported: true },
  { value: 'ecdsa-p256', label: 'ECDSA (P-256)', supported: true },
  { value: 'rsa-4096', label: 'RSA (4096)', supported: true },
  { value: 'ml-dsa', label: 'ML-DSA', supported: false },
];

export default function KeychainPanel() {
  const { keys, identities, importKey, saveKeyFromContent, generateKey, getKeyContent, updateKey, deleteKey, saveIdentity, deleteIdentity } = useAppStore();

  const [showKeyForm, setShowKeyForm] = useState(false);
  const [keyInputMode, setKeyInputMode] = useState<'file' | 'paste' | 'generate'>('file');
  const [keyName, setKeyName] = useState('');
  const [keyPath, setKeyPath] = useState('');
  const [keyContent, setKeyContent] = useState('');
  const [keyPassphrase, setKeyPassphrase] = useState('');
  const [storeContent, setStoreContent] = useState(true);
  const [keyError, setKeyError] = useState('');
  const [savingKey, setSavingKey] = useState(false);

  const [genAlgorithm, setGenAlgorithm] = useState('ed25519');
  const [genResult, setGenResult] = useState<{ private_pem: string; public_openssh: string } | null>(null);
  const [generating, setGenerating] = useState(false);

  const [showIdForm, setShowIdForm] = useState(false);
  const [editId, setEditId] = useState<Identity | null>(null);
  const [idName, setIdName] = useState('');
  const [idUsername, setIdUsername] = useState('');
  const [idKeyId, setIdKeyId] = useState('');
  const [idError, setIdError] = useState('');
  const [savingId, setSavingId] = useState(false);
  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const [editKeyId, setEditKeyId] = useState<string | null>(null);
  const [editKeyName, setEditKeyName] = useState('');
  const [editKeyPrivate, setEditKeyPrivate] = useState('');
  const [editKeyPublic, setEditKeyPublic] = useState<string | null>(null);
  const [editKeySaving, setEditKeySaving] = useState(false);
  const [editKeyLoading, setEditKeyLoading] = useState(false);
  const [editKeyError, setEditKeyError] = useState('');

  function resetKeyForm() {
    setKeyName(''); setKeyPath(''); setKeyContent(''); setKeyPassphrase('');
    setStoreContent(true); setKeyError(''); setKeyInputMode('file');
    setGenResult(null); setGenAlgorithm('ed25519');
  }

  async function handleAddKey(e: React.FormEvent) {
    e.preventDefault();
    if (!keyName.trim()) { setKeyError('Name required'); return; }
    if (keyInputMode === 'file' && !keyPath.trim()) { setKeyError('File path required'); return; }
    if (keyInputMode === 'paste' && !keyContent.trim()) { setKeyError('Key content required'); return; }
    if (keyInputMode === 'generate' && !genResult) { setKeyError('Generate a key first'); return; }
    setSavingKey(true);
    setKeyError('');
    try {
      if (keyInputMode === 'paste') {
        await saveKeyFromContent(keyName.trim(), keyContent.trim(), keyPassphrase || null);
      } else if (keyInputMode === 'generate') {
        await saveKeyFromContent(keyName.trim(), genResult!.private_pem, keyPassphrase || null);
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

  async function handleOpenEditKey(key: { id: string; name: string }) {
    setEditKeyId(key.id);
    setEditKeyName(key.name);
    setEditKeyPrivate('');
    setEditKeyPublic(null);
    setEditKeyError('');
    setEditKeyLoading(true);
    try {
      const content = await getKeyContent(key.id);
      setEditKeyPrivate(content.private_pem);
      setEditKeyPublic(content.public_openssh ?? null);
    } catch (err) {
      setEditKeyError(String(err));
    } finally {
      setEditKeyLoading(false);
    }
  }

  function closeEditKey() {
    setEditKeyId(null);
    setEditKeyName('');
    setEditKeyPrivate('');
    setEditKeyPublic(null);
    setEditKeyError('');
  }

  async function handleSaveEditKey(e: React.FormEvent) {
    e.preventDefault();
    if (!editKeyId) return;
    if (!editKeyName.trim()) { setEditKeyError('Name required'); return; }
    if (!editKeyPrivate.trim()) { setEditKeyError('Private key required'); return; }
    setEditKeySaving(true);
    setEditKeyError('');
    try {
      await updateKey(editKeyId, editKeyName.trim(), editKeyPrivate.trim(), null);
      closeEditKey();
    } catch (err) {
      setEditKeyError(String(err));
    } finally {
      setEditKeySaving(false);
    }
  }

  async function handleGenerate() {
    setGenerating(true);
    setKeyError('');
    setGenResult(null);
    try {
      const result = await generateKey(genAlgorithm);
      setGenResult(result);
    } catch (err) {
      setKeyError(String(err));
    } finally {
      setGenerating(false);
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
    <div className="panel keychain-panel">
      <div className="panel-title">Keychain</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 24 }}>
        <button className="btn-primary btn-sm" onClick={() => setShowKeyForm(true)}>+ Add Key</button>
        <button className="btn-primary btn-sm" onClick={openAddIdentity}>+ Add Identity</button>
      </div>

      {showKeyForm && (
        <>
          <div className="drawer-backdrop" onClick={() => { setShowKeyForm(false); resetKeyForm(); }} />
          <div className="drawer">
            <div className="drawer-header">
              <button className="drawer-close" onClick={() => { setShowKeyForm(false); resetKeyForm(); }}>✕</button>
              <span>Add SSH Key</span>
              <button type="submit" form="key-form" className="btn-primary btn-sm" disabled={savingKey}>
                {savingKey ? 'Saving…' : 'Save Key'}
              </button>
            </div>
            <div className="drawer-body">
              <form id="key-form" className="inline-form" onSubmit={handleAddKey}>
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
                <button
                  type="button"
                  className={`toggle-btn${keyInputMode === 'generate' ? ' active' : ''}`}
                  onClick={() => { setKeyInputMode('generate'); setGenResult(null); }}
                >
                  Generate
                </button>
              </div>
            </div>

            {keyInputMode === 'file' && (
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
            )}

            {keyInputMode === 'paste' && (
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

            {keyInputMode === 'generate' && (
              <>
                <div className="form-group">
                  <label>Algorithm</label>
                  <div className="toggle-row">
                    {KEY_ALGORITHMS.map((alg) => (
                      <button
                        key={alg.value}
                        type="button"
                        className={`toggle-btn${genAlgorithm === alg.value ? ' active' : ''}${!alg.supported ? ' disabled' : ''}`}
                        onClick={() => { if (alg.supported) { setGenAlgorithm(alg.value); setGenResult(null); } }}
                        title={!alg.supported ? 'Not yet supported by SSH servers' : undefined}
                        disabled={!alg.supported}
                      >
                        {alg.label}
                      </button>
                    ))}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  onClick={handleGenerate}
                  disabled={generating}
                  style={{ alignSelf: 'flex-start' }}
                >
                  {generating ? 'Generating…' : genResult ? 'Regenerate' : 'Generate Key'}
                </button>
                {genResult && (
                  <>
                    <div className="form-group">
                      <label>Public key — add this to your server's authorized_keys</label>
                      <div className="key-pub-box">
                        <code>{genResult.public_openssh}</code>
                        <button
                          type="button"
                          className="btn-secondary btn-sm"
                          onClick={() => navigator.clipboard.writeText(genResult.public_openssh)}
                        >
                          Copy
                        </button>
                      </div>
                    </div>
                    <div className="form-group">
                      <label>Private key</label>
                      <div className="key-pub-box">
                        <code>{genResult.private_pem}</code>
                        <button
                          type="button"
                          className="btn-secondary btn-sm"
                          onClick={() => navigator.clipboard.writeText(genResult.private_pem)}
                        >
                          Copy
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </>
            )}

            {keyInputMode !== 'generate' && (
              <div className="form-group">
                <label>Passphrase (if encrypted)</label>
                <input type="password" value={keyPassphrase} onChange={(e) => setKeyPassphrase(e.target.value)} placeholder="leave empty if none" />
              </div>
            )}

                {keyError && <p className="form-error">{keyError}</p>}
              </form>
            </div>
          </div>
        </>
      )}

      {/* Keys */}
      <section className="panel-section">
        <div className="panel-section-header">
          <h3>SSH Keys</h3>
        </div>

        {keys.length === 0
          ? <p className="list-empty">No keys added yet.</p>
          : <div className="kc-grid">
              {keys.map((key) => (
                <div key={key.id} className="kc-card kc-card--clickable" onClick={() => handleOpenEditKey(key)}>
                  <div className="kc-card-info">
                    <span className="kc-card-name">{key.name}</span>
                    <span className="kc-card-detail">
                      {key.algorithm ?? (key.key_path ? 'file path' : 'unknown')}
                      {key.encrypted_passphrase === '[stored]' && ' · passphrase'}
                    </span>
                  </div>
                  <button className="kc-card-edit-btn" onClick={(e) => { e.stopPropagation(); handleOpenEditKey(key); }} title="Edit" disabled={editKeyLoading}>
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                  </button>
                </div>
              ))}
            </div>
        }
      </section>

      {showIdForm && (
        <>
          <div className="drawer-backdrop" onClick={() => setShowIdForm(false)} />
          <div className="drawer">
            <div className="drawer-header">
              <button className="drawer-close" onClick={() => setShowIdForm(false)}>✕</button>
              <span>{editId ? 'Edit Identity' : 'Add Identity'}</span>
              <button type="submit" form="identity-form" className="btn-primary btn-sm" disabled={savingId}>
                {savingId ? 'Saving…' : 'Save'}
              </button>
            </div>
            <div className="drawer-body">
              <form id="identity-form" className="inline-form" onSubmit={handleSaveIdentity}>
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
              </form>
            </div>
            {editId && (
              <div className="drawer-footer">
                <button
                  className="btn-danger btn-sm"
                  onClick={() => setConfirmDeleteId(editId.id)}
                >
                  Delete Identity
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {/* Identities */}
      <section className="panel-section">
        <div className="panel-section-header">
          <h3>Identities</h3>
        </div>

        {identities.length === 0
          ? <p className="list-empty">No identities. Add a key first.</p>
          : <div className="kc-grid">
              {identities.map((id) => {
                const key = keys.find((k) => k.id === id.key_id);
                return (
                  <div key={id.id} className={`kc-card kc-card--clickable${!key ? ' warn' : ''}`} onClick={() => openEditIdentity(id)}>
                    <div className="kc-card-info">
                      <span className="kc-card-name">{id.name}</span>
                      <span className="kc-card-detail">{id.username}</span>
                      <span className="kc-card-detail">
                        {key ? key.name : <span className="warn-text">key deleted</span>}
                      </span>
                    </div>
                    <button className="kc-card-edit-btn" onClick={(e) => { e.stopPropagation(); openEditIdentity(id); }} title="Edit">
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                      </svg>
                    </button>
                  </div>
                );
              })}
            </div>
        }
      </section>
      {editKeyId && (
        <>
          <div className="drawer-backdrop" onClick={closeEditKey} />
          <div className="drawer">
            <div className="drawer-header">
              <button className="drawer-close" onClick={closeEditKey}>✕</button>
              <span>Edit Key</span>
              <button type="submit" form="edit-key-form" className="btn-primary btn-sm" disabled={editKeySaving || editKeyLoading}>
                {editKeySaving ? 'Saving…' : 'Save'}
              </button>
            </div>
            <div className="drawer-body">
              {editKeyLoading
                ? <p style={{ padding: '16px', opacity: 0.6 }}>Loading…</p>
                : (
                  <form id="edit-key-form" className="inline-form" onSubmit={handleSaveEditKey}>
                    <div className="form-group">
                      <label>Name</label>
                      <input
                        value={editKeyName}
                        onChange={(e) => setEditKeyName(e.target.value)}
                        placeholder="Key name"
                        autoFocus
                      />
                    </div>
                    {editKeyPublic && (
                      <div className="form-group">
                        <label>Public key</label>
                        <div className="key-pub-box">
                          <code>{editKeyPublic}</code>
                          <button
                            type="button"
                            className="btn-secondary btn-sm"
                            onClick={() => navigator.clipboard.writeText(editKeyPublic!)}
                          >
                            Copy
                          </button>
                        </div>
                      </div>
                    )}
                    <div className="form-group">
                      <label>Private key</label>
                      <div className="key-pub-box key-pub-box--tall">
                        <textarea
                          className="key-paste-area"
                          value={editKeyPrivate}
                          onChange={(e) => setEditKeyPrivate(e.target.value)}
                          rows={10}
                          spellCheck={false}
                        />
                        <button
                          type="button"
                          className="btn-secondary btn-sm"
                          onClick={() => navigator.clipboard.writeText(editKeyPrivate)}
                        >
                          Copy
                        </button>
                      </div>
                    </div>
                    {editKeyError && <p className="form-error">{editKeyError}</p>}
                  </form>
                )
              }
            </div>
            {!editKeyLoading && (
              <div className="drawer-footer">
                <button
                  className="btn-danger btn-sm"
                  onClick={() => setConfirmDeleteKey(editKeyId!)}
                >
                  Delete Key
                </button>
              </div>
            )}
          </div>
        </>
      )}

      {confirmDeleteKey && (
        <>
          <div className="modal-overlay" onClick={() => setConfirmDeleteKey(null)} />
          <div className="kc-confirm-modal">
            <p>Delete this key?</p>
            <div className="kc-confirm-actions">
              <button className="btn-secondary btn-sm" onClick={() => setConfirmDeleteKey(null)}>Cancel</button>
              <button className="btn-danger btn-sm" onClick={() => { deleteKey(confirmDeleteKey); setConfirmDeleteKey(null); closeEditKey(); }}>Delete</button>
            </div>
          </div>
        </>
      )}

      {confirmDeleteId && (
        <>
          <div className="modal-overlay" onClick={() => setConfirmDeleteId(null)} />
          <div className="kc-confirm-modal">
            <p>Delete this identity?</p>
            <div className="kc-confirm-actions">
              <button className="btn-secondary btn-sm" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
              <button className="btn-danger btn-sm" onClick={() => { deleteIdentity(confirmDeleteId); setConfirmDeleteId(null); setShowIdForm(false); }}>Delete</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
