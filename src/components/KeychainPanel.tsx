import { useState, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore, reportFailure } from '../store/appStore';
import type { AgentKeyInfo, Identity } from '../types';
import ConfirmModal from './shared/ConfirmModal';
import ContextMenu from './shared/ContextMenu';
import Drawer from './shared/Drawer';
import PassphraseInput from './shared/PassphraseInput';

const KEY_ALGORITHMS = [
  { value: 'ed25519', label: 'ED25519' },
  { value: 'ecdsa-p256', label: 'ECDSA (P-256)' },
  { value: 'rsa', label: 'RSA' },
];

const RSA_SIZES = [2048, 4096];

export default function KeychainPanel() {
  const { keys, identities, settings, saveKeyFromContent, generateKey, getKeyContent, updateKey, deleteKey, saveIdentity, deleteIdentity } = useAppStore();
  const hint = (t: string) => settings.show_hover_hints ? t : undefined;

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
  const [genPassphrase, setGenPassphrase] = useState('');

  // identity drawer
  const [showIdForm, setShowIdForm] = useState(false);
  const [editId, setEditId] = useState<Identity | null>(null);
  const [idName, setIdName] = useState('');
  const [idUsername, setIdUsername] = useState('');
  const [idAuthType, setIdAuthType] = useState<'key' | 'password' | 'keyboard-interactive' | 'agent'>('key');
  const [idAgentFingerprint, setIdAgentFingerprint] = useState('');
  const [agentKeys, setAgentKeys] = useState<AgentKeyInfo[] | null>(null);
  const [agentError, setAgentError] = useState('');
  const [idKeyId, setIdKeyId] = useState('');
  const [idPassword, setIdPassword] = useState('');
  const [idKeyDropdownOpen, setIdKeyDropdownOpen] = useState(false);
  const [idError, setIdError] = useState('');
  const [savingId, setSavingId] = useState(false);

  const [confirmDeleteKey, setConfirmDeleteKey] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  type KcCtx = { x: number; y: number; kind: 'key'; id: string } | { x: number; y: number; kind: 'identity'; id: string } | { x: number; y: number; kind: 'panel' };
  const [ctxMenu, setCtxMenu] = useState<KcCtx | null>(null);

  // Only queried when the user picks Agent, so a missing agent costs nothing
  // for everyone else.
  useEffect(() => {
    if (idAuthType !== 'agent' || !showIdForm) return;
    let cancelled = false;
    setAgentError('');
    invoke<AgentKeyInfo[]>('list_agent_keys')
      .then((k) => { if (!cancelled) setAgentKeys(k); })
      .catch((e) => { if (!cancelled) { setAgentKeys([]); setAgentError(String(e)); } });
    return () => { cancelled = true; };
  }, [idAuthType, showIdForm]);

  // edit key drawer
  const [editKeyId, setEditKeyId] = useState<string | null>(null);
  const [editKeyName, setEditKeyName] = useState('');
  const [editKeyPrivate, setEditKeyPrivate] = useState('');
  const [editKeyPublic, setEditKeyPublic] = useState<string | null>(null);
  const [editKeyPassphrase, setEditKeyPassphrase] = useState('');
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
      const text = (ev.target?.result as string).trim();
      if (!keyName.trim()) setKeyName(file.name.replace(/\.(ppk|pem|key|txt)$/i, ''));
      setKeyContent(text);
      setKeyError('');
    };
    reader.readAsText(file);
    e.target.value = '';
  }

  function resetGenForm() {
    setGenKeyName(''); setGenKeyError(''); setGenResult(null); setGenAlgorithm('ed25519'); setRsaSize(4096); setGenPassphrase('');
  }

  async function handleAddKey(e: React.FormEvent) {
    e.preventDefault();
    if (!keyName.trim()) { setKeyError('Name required'); return; }
    if (!keyContent.trim()) { setKeyError('Key content required'); return; }
    setSavingKey(true);
    setKeyError('');
    try {
      let content = keyContent.trim();
      let passphraseToStore: string | null = keyPassphrase || null;
      if (content.startsWith('PuTTY-User-Key-File')) {
        content = await invoke<string>('convert_ppk', {
          content,
          passphrase: keyPassphrase || null,
        });
        passphraseToStore = null;
      }
      await saveKeyFromContent(keyName.trim(), content, passphraseToStore);
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
      await saveKeyFromContent(genKeyName.trim(), genResult.private_pem, genPassphrase || null);
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
      setEditKeyPassphrase(content.passphrase ?? '');
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
    setEditKeyPassphrase('');
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
      await updateKey(editKeyId, editKeyName.trim(), editKeyPrivate.trim(), editKeyPassphrase || null);
      closeEditKey();
    } catch (err) {
      setEditKeyError(String(err));
    } finally {
      setEditKeySaving(false);
    }
  }

  function openAddIdentity() {
    setEditId(null);
    setIdName(''); setIdUsername(''); setIdAuthType('key'); setIdKeyId(''); setIdPassword(''); setIdError('');
    setIdAgentFingerprint('');
    setShowIdForm(true);
  }

  function openEditIdentity(id: Identity) {
    setEditId(id);
    const authType = id.auth_kind === 'keyboard-interactive'
      ? 'keyboard-interactive' as const
      : id.auth_kind === 'agent'
        ? 'agent' as const
        : id.encrypted_password === '[stored]' ? 'password' as const : 'key' as const;
    setIdName(id.name); setIdUsername(id.username);
    setIdAuthType(authType); setIdKeyId(id.key_id ?? ''); setIdPassword(''); setIdError('');
    setIdAgentFingerprint(id.agent_fingerprint ?? '');
    setShowIdForm(true);
  }

  async function handleSaveIdentity(e: React.FormEvent) {
    e.preventDefault();
    if (!idName.trim() || !idUsername.trim()) { setIdError('Name and username required'); return; }
    if (idAuthType === 'key' && !idKeyId) { setIdError('Select a key'); return; }
    if (idAuthType === 'password' && !idPassword && editId?.encrypted_password !== '[stored]') {
      setIdError('Password required'); return;
    }
    setSavingId(true);
    setIdError('');
    try {
      await saveIdentity(
        {
          id: editId?.id ?? '',
          name: idName.trim(),
          username: idUsername.trim(),
          key_id: idAuthType === 'key' ? idKeyId : null,
          encrypted_password: null,
          auth_kind: idAuthType === 'keyboard-interactive' || idAuthType === 'agent' ? idAuthType : null,
          agent_fingerprint: idAuthType === 'agent' && idAgentFingerprint ? idAgentFingerprint : null,
        },
        idAuthType === 'password' && idPassword ? idPassword : undefined,
      );
      setShowIdForm(false);
    } catch (err) {
      setIdError(String(err));
    } finally {
      setSavingId(false);
    }
  }

  return (
    <div className="panel keychain-panel" onContextMenu={(e) => { if ((e.target as HTMLElement).closest('button, input, textarea, select, label, a')) return; e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, kind: 'panel' }); }}>
      <div className="panel-title" style={{ marginBottom: 6 }}>Keychain</div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>

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
                className="dropdown-scrim"
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
        <Drawer
          title="Add SSH Key"
          onClose={() => { setShowKeyForm(false); resetKeyForm(); }}
          action={
            <button type="submit" form="key-form" className="btn-primary btn-sm" disabled={savingKey}>
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
                <PassphraseInput
                  value={keyPassphrase}
                  onChange={setKeyPassphrase}
                  placeholder="leave empty if none"
                />
              </div>
              {keyContent.trimStart().startsWith('PuTTY-User-Key-File') && (
                <p className="form-info">PPK file will be converted to OpenSSH format on save.</p>
              )}
              {keyError && <p className="form-error">{keyError}</p>}
              <input
                ref={keyFileInputRef}
                type="file"
                accept=".ppk,.pem,.key,.txt,*"
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
        </Drawer>
      )}

      {/* Generate key drawer */}
      {showGenForm && (
        <Drawer
          title="Generate SSH Key"
          onClose={() => { setShowGenForm(false); resetGenForm(); }}
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
        </Drawer>
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
                <div key={key.id} className="kc-card kc-card--clickable" onClick={() => handleOpenEditKey(key)} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtxMenu({ x: e.clientX, y: e.clientY, kind: 'key', id: key.id }); }}>
                  <div className="card-body">
                    <span className="card-title">{key.name}</span>
                    <span className="kc-card-detail">
                      {key.algorithm ?? (key.key_path ? 'file path' : 'unknown')}
                      {key.encrypted_passphrase === '[stored]' && ' · passphrase'}
                    </span>
                  </div>
                  <button className="kc-card-edit-btn" onClick={(e) => { e.stopPropagation(); handleOpenEditKey(key); }} title={hint('Edit')} disabled={editKeyLoading}>
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
        <Drawer
          title={editId ? 'Edit Identity' : 'Add Identity'}
          onClose={() => setShowIdForm(false)}
          action={
            <button type="submit" form="identity-form" className="btn-primary btn-sm" disabled={savingId}>
              {savingId ? 'Saving…' : 'Save'}
            </button>
          }
        >
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
                <label>Auth</label>
                <div className="toggle-row">
                  <button type="button" className={`toggle-btn${idAuthType === 'key' ? ' active' : ''}`} onClick={() => setIdAuthType('key')}>Key</button>
                  <button type="button" className={`toggle-btn${idAuthType === 'password' ? ' active' : ''}`} onClick={() => setIdAuthType('password')}>Password</button>
                  <button type="button" className={`toggle-btn${idAuthType === 'keyboard-interactive' ? ' active' : ''}`} onClick={() => setIdAuthType('keyboard-interactive')}>Prompt</button>
                  <button type="button" className={`toggle-btn${idAuthType === 'agent' ? ' active' : ''}`} onClick={() => setIdAuthType('agent')}>Agent</button>
                </div>
                {idAuthType === 'keyboard-interactive' && (
                  <p className="form-hint">
                    The server asks for a password, one-time code, or both at connect time.
                    Nothing is stored. Use this for PAM or two-factor logins.
                  </p>
                )}
              </div>
              {idAuthType === 'agent' ? (
                <div className="form-group">
                  {agentError ? (
                    <p className="form-hint form-hint-error">{agentError}</p>
                  ) : agentKeys === null ? (
                    <p className="form-hint">Reading ssh-agent…</p>
                  ) : agentKeys.length === 0 ? (
                    <p className="form-hint">
                      ssh-agent is running but holds no usable keys. Add one with <code>ssh-add</code>.
                    </p>
                  ) : (
                    <>
                      <div className="agentkey-list">
                        <button
                          type="button"
                          className={`agentkey${idAgentFingerprint === '' ? ' active' : ''}`}
                          onClick={() => setIdAgentFingerprint('')}
                        >
                          <span className="agentkey-name">Any key the agent offers</span>
                          <span className="agentkey-meta">tries each in turn</span>
                        </button>
                        {agentKeys.map((k) => (
                          <button
                            type="button"
                            key={k.fingerprint}
                            className={`agentkey${idAgentFingerprint === k.fingerprint ? ' active' : ''}`}
                            onClick={() => setIdAgentFingerprint(k.fingerprint)}
                          >
                            <span className="agentkey-name">{k.algorithm}</span>
                            <span className="agentkey-meta">{k.fingerprint}</span>
                          </button>
                        ))}
                      </div>
                      <p className="form-hint">
                        The agent signs on your behalf; the private key never reaches BifroSSH.
                      </p>
                    </>
                  )}
                </div>
              ) : idAuthType === 'keyboard-interactive' ? null : idAuthType === 'key' ? (
                <div className="form-group">
                  <div className="picker" style={{ position: 'relative' }}>
                    <button
                      type="button"
                      className="picker-btn"
                      onClick={() => setIdKeyDropdownOpen((o) => !o)}
                    >
                      <span>{keys.find((k) => k.id === idKeyId)?.name ?? 'Select key…'}</span>
                      <svg width="10" height="6" viewBox="0 0 10 6" fill="currentColor"><path d="M0 0l5 6 5-6z"/></svg>
                    </button>
                    {idKeyDropdownOpen && (
                      <>
                        <div className="dropdown-scrim" onClick={() => setIdKeyDropdownOpen(false)} />
                        <div className="picker-menu">
                          {keys.map((k) => (
                            <button
                              key={k.id}
                              type="button"
                              className={`picker-item${idKeyId === k.id ? ' selected' : ''}`}
                              onClick={() => { setIdKeyId(k.id); setIdKeyDropdownOpen(false); }}
                            >
                              {k.name}
                            </button>
                          ))}
                          {keys.length > 0 && <div className="picker-divider" />}
                          <button
                            type="button"
                            className="picker-item picker-add"
                            onClick={() => { setIdKeyDropdownOpen(false); setShowKeyForm(true); resetKeyForm(); }}
                          >
                            + Add Key…
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>
              ) : (
                <div className="form-group">
                  <PassphraseInput
                    value={idPassword}
                    onChange={setIdPassword}
                    placeholder={editId?.encrypted_password === '[stored]' ? 'leave blank to keep existing' : 'password'}
                  />
                </div>
              )}
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
        </Drawer>
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
                // A prompt identity stores neither a key nor a password, so it
                // must be checked first or it looks like a key that went missing.
                const isPromptAuth = id.auth_kind === 'keyboard-interactive';
                const isAgentAuth = id.auth_kind === 'agent';
                const storedless = isPromptAuth || isAgentAuth;
                const isPasswordAuth = !storedless && id.encrypted_password === '[stored]';
                const key = storedless || isPasswordAuth ? null : keys.find((k) => k.id === id.key_id);
                const keyMissing = !storedless && !isPasswordAuth && !key;
                return (
                  <div key={id.id} className={`kc-card kc-card--clickable${keyMissing ? ' warn' : ''}`} onClick={() => openEditIdentity(id)} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtxMenu({ x: e.clientX, y: e.clientY, kind: 'identity', id: id.id }); }}>
                    <div className="card-body">
                      <span className="card-title">{id.name}</span>
                      <span className="kc-card-detail">{id.username}</span>
                      <span className="kc-card-detail">
                        {isPromptAuth ? 'prompt' : isAgentAuth ? 'ssh-agent' : isPasswordAuth ? 'password' : key ? key.name : <span className="warn-text">key deleted</span>}
                      </span>
                    </div>
                    <button className="kc-card-edit-btn" onClick={(e) => { e.stopPropagation(); openEditIdentity(id); }} title={hint('Edit')}>
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
        <Drawer
          title="Edit Key"
          onClose={closeEditKey}
          action={
            <button type="submit" form="edit-key-form" className="btn-primary btn-sm" disabled={editKeySaving || editKeyLoading}>
              {editKeySaving ? 'Saving…' : 'Save'}
            </button>
          }
        >
          <div className="drawer-body">
            {editKeyLoading
              ? <p style={{ padding: '16px', opacity: 0.6 }}>Loading…</p>
              : (
                <form id="edit-key-form" className="inline-form" onSubmit={handleSaveEditKey}>
                  <div className="form-group">
                    <label>Name</label>
                    <input value={editKeyName} onChange={(e) => setEditKeyName(e.target.value)} placeholder="Key name" autoFocus />
                  </div>
                  <div className="form-group">
                    <label>Passphrase</label>
                    <PassphraseInput
                      value={editKeyPassphrase}
                      onChange={setEditKeyPassphrase}
                      placeholder="leave blank to keep existing"
                    />
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
        </Drawer>
      )}

      {ctxMenu && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} onClose={() => setCtxMenu(null)}>
          {ctxMenu.kind === 'panel' ? (
            <>
              <button className="menu-item" onClick={() => { setCtxMenu(null); setShowKeyForm(true); }}>Add Key</button>
              <button className="menu-item" onClick={() => { setCtxMenu(null); setShowGenForm(true); }}>Generate Key</button>
              <div className="menu-divider" />
              <button className="menu-item" onClick={() => { setCtxMenu(null); setShowIdForm(true); }}>Add Identity</button>
            </>
          ) : (
            <>
              <button className="menu-item" onClick={() => {
                setCtxMenu(null);
                if (ctxMenu.kind === 'key') { const k = keys.find(k => k.id === ctxMenu.id); if (k) handleOpenEditKey(k); }
                else { const id = identities.find(i => i.id === ctxMenu.id); if (id) openEditIdentity(id); }
              }}>Edit</button>
              <div className="menu-divider" />
              <button className="menu-item menu-item-danger" onClick={() => {
                const id = ctxMenu.id;
                setCtxMenu(null);
                if (ctxMenu.kind === 'key') setConfirmDeleteKey(id);
                else setConfirmDeleteId(id);
              }}>Delete</button>
            </>
          )}
        </ContextMenu>
      )}

      {confirmDeleteKey && (
        <ConfirmModal
          question="Delete this key?"
          onCancel={() => setConfirmDeleteKey(null)}
          onConfirm={() => { deleteKey(confirmDeleteKey).catch(reportFailure); setConfirmDeleteKey(null); closeEditKey(); }}
        />
      )}

      {confirmDeleteId && (
        <ConfirmModal
          question="Delete this identity?"
          onCancel={() => setConfirmDeleteId(null)}
          onConfirm={() => { deleteIdentity(confirmDeleteId).catch(reportFailure); setConfirmDeleteId(null); setShowIdForm(false); }}
        />
      )}
    </div>
  );
}
