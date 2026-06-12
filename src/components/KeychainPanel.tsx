import { useState, useRef } from 'react';
import { useAppStore } from '../store/appStore';
import type { Identity } from '../types';

const KEY_ALGORITHMS = [
  { value: 'ed25519', label: 'ED25519' },
  { value: 'ecdsa-p256', label: 'ECDSA (P-256)' },
  { value: 'rsa', label: 'RSA' },
];

const RSA_SIZES = [1024, 2048, 4096];

export default function KeychainPanel() {
  const { keys, identities, saveKeyFromContent, generateKey, getKeyContent, updateKey, deleteKey, saveIdentity, deleteIdentity } = useAppStore();

  // import drawer
  const [showKeyForm, setShowKeyForm] = useState(false);
  const [keyName, setKeyName] = useState('');
  const [keyContent, setKeyContent] = useState('');
  const [keyPassphrase, setKeyPassphrase] = useState('');
  const [keyError, setKeyError] = useState('');
  const [savingKey, setSavingKey] = useState(false);
  const keyFileInputRef = useRef<HTMLInputElement>(null);

  // generate drawer
  const [showGenForm, setShowGenForm] = useState(false);
  const [showKeyDropdown, setShowKeyDropdown] = useState(false);
  const [genKeyName, setGenKeyName] = useState('');
  const [genKeyError, setGenKeyError] = useState('');
  const [genSaving, setGenSaving] = useState(false);
  const [genAlgorithm, setGenAlgorithm] = useState('ed25519');
  const [rsaSize, setRsaSize] = useState(4096);
  const [genResult, setGenResult] = useState<{ private_pem: string; public_openssh: string } | null>(null);
  const [generating, setGenerating] = useState(false);

  // identity drawer
  const [showIdForm, setShowIdForm] = useState(false);
  const [editId, setEditId] = useState<Identity | null>(null);
  const [idName, setIdName] = useState('');
  const [idUsername, setIdUsername] = useState('');
  const [idKeyId, setIdKeyId] = useState('');
  const [idError, setIdError] = useState('');
  const [savingId, setSavingId] = useState(false);

  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // edit key drawer
  const [editKeyId, setEditKeyId] = useState<string | null>(null);
  const [editKeyName, setEditKeyName] = useState('');
  const [editKeyPrivate, setEditKeyPrivate] = useState('');
  const [editKeyPublic, setEditKeyPublic] = useState<string | null>(null);
  const [editKeySaving, setEditKeySaving] = useState(false);
  const [editKeyLoading, setEditKeyLoading] = useState(false);
  const [editKeyError, setEditKeyError] = useState('');

  function resetKeyForm() {
    setKeyName(''); setKeyContent(''); setKeyPassphrase(''); setKeyError('');
  }

  function handleKeyFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target?.result as string;
      setKeyContent(text.trim());
      if (!keyName.trim()) setKeyName(file.name.replace(/\.(pem|key|txt)$/i, ''));
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function resetGenForm() {
    setGenKeyName(''); setGenKeyError(''); setGenResult(null); setGenAlgorithm('ed25519'); setRsaSize(4096);
  }

  async function handleAddKey(e: React.FormEvent) {
    e.preventDefault();
    if (!keyName.trim()) { setKeyError('Name required'); return; }
    if (!keyContent.trim()) { setKeyError('Key content required'); return; }
    setSavingKey(true);
    setKeyError('');
    try {
      await saveKeyFromContent(keyName.trim(), keyContent.trim(), keyPassphrase || null);
      setShowKeyForm(false);
      resetKeyForm();
    } catch (err) {
      setKeyError(String(err));
    } finally {
      setSavingKey(false);
    }
  }

  async function handleGenerate() {
    setGenerating(true);
    setGenKeyError('');
    setGenResult(null);
    try {
      const algoArg = genAlgorithm === 'rsa' ? `rsa-${rsaSize}` : genAlgorithm;
      const result = await generateKey(algoArg);
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
      await saveKeyFromContent(genKeyName.trim(), genResult.private_pem, null);
      setShowGenForm(false);
      resetGenForm();
    } catch (err) {
      setGenKeyError(String(err));
    } finally {
      setGenSaving(false);
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

        {/* Add Key split-style button */}
        <div style={{ position: 'relative' }}>
          <div className="add-key-btn-group">
            <button
              className="add-key-btn-main btn-primary btn-sm"
              onClick={() => setShowKeyForm(true)}
            >
              + Add Key
            </button>
            <button
              className="add-key-btn-caret btn-primary btn-sm"
              onClick={(e) => { e.stopPropagation(); setShowKeyDropdown((d) => !d); }}
              aria-label="More key options"
            >
              <svg width="10" height="10" viewBox="0 0 10 6" fill="currentColor">
                <path d="M0 0l5 6 5-6z"/>
              </svg>
            </button>
          </div>
          {showKeyDropdown && (
            <>
              <div
                style={{ position: 'fixed', inset: 0, zIndex: 99 }}
                onClick={() => setShowKeyDropdown(false)}
              />
              <div className="key-dropdown">
                <button onClick={() => { setShowKeyDropdown(false); setShowGenForm(true); resetGenForm(); }}>
                  Generate Key
                </button>
              </div>
            </>
          )}
        </div>

        <button className="btn-primary btn-sm" onClick={openAddIdentity}>+ Add Identity</button>
      </div>

      {/* Import key drawer */}
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
                  <label>Private key</label>
                  <textarea
                    className="key-paste-area"
                    value={keyContent}
                    onChange={(e) => setKeyContent(e.target.value)}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;..."
                    rows={8}
                    spellCheck={false}
                  />
                </div>
                <div className="form-group">
                  <label>Passphrase (if encrypted)</label>
                  <input type="password" value={keyPassphrase} onChange={(e) => setKeyPassphrase(e.target.value)} placeholder="leave empty if none" />
                </div>
                {keyError && <p className="form-error">{keyError}</p>}
                <input
                  ref={keyFileInputRef}
                  type="file"
                  accept=".pem,.key,.txt,*"
                  style={{ display: 'none' }}
                  onChange={handleKeyFileSelect}
                />
                <button
                  type="button"
                  className="btn-secondary btn-sm"
                  style={{ alignSelf: 'flex-start' }}
                  onClick={() => keyFileInputRef.current?.click()}
                >
                  Import from key file
                </button>
              </form>
            </div>
          </div>
        </>
      )}

      {/* Generate key drawer */}
      {showGenForm && (
        <>
          <div className="drawer-backdrop" onClick={() => { setShowGenForm(false); resetGenForm(); }} />
          <div className="drawer">
            <div className="drawer-header">
              <button className="drawer-close" onClick={() => { setShowGenForm(false); resetGenForm(); }}>✕</button>
              <span>Generate SSH Key</span>
              <button type="submit" form="gen-key-form" className="btn-primary btn-sm" disabled={genSaving || !genResult}>
                {genSaving ? 'Saving…' : 'Save Key'}
              </button>
            </div>
            <div className="drawer-body">
              <form id="gen-key-form" className="inline-form" onSubmit={handleSaveGenerated}>
                <div className="form-group">
                  <label>Name</label>
                  <input value={genKeyName} onChange={(e) => setGenKeyName(e.target.value)} placeholder="My Generated Key" autoFocus />
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
                        <button type="button" className="btn-secondary btn-sm" onClick={() => navigator.clipboard.writeText(genResult!.public_openssh)}>Copy</button>
                      </div>
                    </div>
                    <div className="form-group">
                      <label>Private key</label>
                      <div className="key-pub-box">
                        <code>{genResult.private_pem}</code>
                        <button type="button" className="btn-secondary btn-sm" onClick={() => navigator.clipboard.writeText(genResult!.private_pem)}>Copy</button>
                      </div>
                    </div>
                  </>
                )}
                {genKeyError && <p className="form-error">{genKeyError}</p>}
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

      {/* Identity drawer */}
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
                <button className="btn-danger btn-sm" onClick={() => setConfirmDeleteId(editId.id)}>
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

      {/* Edit key drawer */}
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
                      <input value={editKeyName} onChange={(e) => setEditKeyName(e.target.value)} placeholder="Key name" autoFocus />
                    </div>
                    {editKeyPublic && (
                      <div className="form-group">
                        <label>Public key</label>
                        <div className="key-pub-box">
                          <code>{editKeyPublic}</code>
                          <button type="button" className="btn-secondary btn-sm" onClick={() => navigator.clipboard.writeText(editKeyPublic!)}>Copy</button>
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
                        <button type="button" className="btn-secondary btn-sm" onClick={() => navigator.clipboard.writeText(editKeyPrivate)}>Copy</button>
                      </div>
                    </div>
                    {editKeyError && <p className="form-error">{editKeyError}</p>}
                  </form>
                )
              }
            </div>
            {!editKeyLoading && (
              <div className="drawer-footer">
                <button className="btn-danger btn-sm" onClick={() => setConfirmDeleteKey(editKeyId!)}>Delete Key</button>
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
