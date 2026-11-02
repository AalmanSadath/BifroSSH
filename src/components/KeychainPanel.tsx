import { useState, useEffect } from 'react';
import * as ipc from '../ipc';
import { useAppStore, reportFailure } from '../store/appStore';
import { useCopy } from './shared/useCopy';
import { useHint } from './shared/useHint';
import { STORED } from '../types';
import type { AgentKeyInfo, Identity } from '../types';
import ConfirmModal from './shared/ConfirmModal';
import ContextMenu from './shared/ContextMenu';
import KeyCertificate from './KeyCertificate';
import KeyCreateDrawer from './KeyCreateDrawer';
import AutoTextarea from './shared/AutoTextarea';
import Drawer from './shared/Drawer';
import PassphraseInput from './shared/PassphraseInput';
import { cardKeys } from './shared/cardKeys';
import { EditIcon } from './shared/icons';
import PortalDropdown, { CHEVRON } from './shared/PortalDropdown';
import { isAndroid } from '../platform';

/** Card activation, plus the single click these two use to reach it. */
function clickableProps(onActivate: () => void) {
  return { ...cardKeys(onActivate), onClick: onActivate };
}

export default function KeychainPanel() {
  const { keys, identities, getKeyContent, updateKey, setKeyCertificate, deleteKey, saveIdentity, deleteIdentity } = useAppStore();
  // Four copy buttons, each saying so for itself.
  const { copied, copy } = useCopy();
  const hint = useHint();

  // The add-key drawer, and whether the identity form opened it, in which case
  // the key it makes is the one the identity uses.
  const [keyDrawer, setKeyDrawer] = useState<{ mode: 'import' | 'generate'; forIdentity: boolean } | null>(null);
  const [showKeyDropdown, setShowKeyDropdown] = useState(false);

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
    ipc.listAgentKeys()
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
  const [editKeyCert, setEditKeyCert] = useState('');
  /** What the certificate field says is wrong; the save waits until it is fixed or cleared. */
  const [certProblem, setCertProblem] = useState('');

  async function handleOpenEditKey(key: { id: string; name: string; certificate?: string | null }) {
    setEditKeyId(key.id);
    setEditKeyName(key.name);
    setEditKeyCert(key.certificate ?? '');
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
    setEditKeyCert('');
  }

  async function handleSaveEditKey(e: React.FormEvent) {
    e.preventDefault();
    if (!editKeyId) return;
    if (!editKeyName.trim()) { setEditKeyError('Name required'); return; }
    if (!editKeyPrivate.trim()) { setEditKeyError('Private key required'); return; }
    if (certProblem) return;
    setEditKeySaving(true);
    setEditKeyError('');
    try {
      await updateKey(editKeyId, editKeyName.trim(), editKeyPrivate.trim(), editKeyPassphrase || null);
      // After the key itself, so a new certificate is checked against the
      // key as just saved. Sent every time: a save of a different key can
      // have dropped the old one as no longer matching.
      await setKeyCertificate(editKeyId, editKeyCert.trim() || null);
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
        : id.encrypted_password === STORED ? 'password' as const : 'key' as const;
    setIdName(id.name); setIdUsername(id.username);
    setIdAuthType(authType); setIdKeyId(id.key_id ?? ''); setIdPassword(''); setIdError('');
    setIdAgentFingerprint(id.agent_fingerprint ?? '');
    setShowIdForm(true);
  }

  async function handleSaveIdentity(e: React.FormEvent) {
    e.preventDefault();
    if (!idName.trim() || !idUsername.trim()) { setIdError('Name and username required'); return; }
    if (idAuthType === 'key' && !idKeyId) { setIdError('Select a key'); return; }
    if (idAuthType === 'password' && !idPassword && editId?.encrypted_password !== STORED) {
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
      <div className="panel-title panel-title-tight">Keychain</div>
      <div className="panel-toolbar">

        {/* Add Key split-style button */}
        <div style={{ position: 'relative' }}>
          <div className="add-key-btn-group">
            <button
              className="add-key-btn-main btn-primary btn-sm"
              onClick={() => setKeyDrawer({ mode: 'import', forIdentity: false })}
            >
              + Add Key
            </button>
            <button
              className="add-key-btn-caret btn-primary btn-sm"
              onClick={(e) => { e.stopPropagation(); setShowKeyDropdown((d) => !d); }}
              aria-label="More key options"
            >
              {CHEVRON}
            </button>
          </div>
          {showKeyDropdown && (
            <>
              <div
                className="dropdown-scrim"
                onClick={() => setShowKeyDropdown(false)}
              />
              <div className="key-dropdown">
                <button onClick={() => { setShowKeyDropdown(false); setKeyDrawer({ mode: 'generate', forIdentity: false }); }}>
                  Generate Key
                </button>
              </div>
            </>
          )}
        </div>

        <button className="btn-primary btn-sm" onClick={openAddIdentity}>+ Add Identity</button>
      </div>

      {keyDrawer && (
        <KeyCreateDrawer
          mode={keyDrawer.mode}
          onClose={() => setKeyDrawer(null)}
          onSaved={keyDrawer.forIdentity ? (k) => setIdKeyId(k.id) : undefined}
        />
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
                <div key={key.id} className="kc-card kc-card--clickable" {...clickableProps(() => handleOpenEditKey(key))} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtxMenu({ x: e.clientX, y: e.clientY, kind: 'key', id: key.id }); }}>
                  <div className="card-body">
                    <span className="card-title">{key.name}</span>
                    <span className="kc-card-detail">
                      {key.algorithm ?? (key.key_path ? 'file path' : 'unknown')}
                      {key.encrypted_passphrase === STORED && ' · passphrase'}
                      {key.certificate && ' · certificate'}
                    </span>
                  </div>
                  <button className="card-edit-btn" onClick={(e) => { e.stopPropagation(); handleOpenEditKey(key); }} title={hint('Edit')} disabled={editKeyLoading}>
                    <EditIcon />
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
                  {!isAndroid && <button type="button" className={`toggle-btn${idAuthType === 'agent' ? ' active' : ''}`} onClick={() => setIdAuthType('agent')}>Agent</button>}
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
                  <div className="picker">
                    <PortalDropdown label={keys.find((k) => k.id === idKeyId)?.name ?? 'Select key…'}>
                      {(close) => (
                        <>
                          {keys.map((k) => (
                            <button
                              key={k.id}
                              type="button"
                              className={`picker-item${idKeyId === k.id ? ' selected' : ''}`}
                              onMouseDown={(e) => { e.preventDefault(); setIdKeyId(k.id); close(); }}
                            >
                              {k.name}
                            </button>
                          ))}
                          {keys.length > 0 && <div className="picker-divider" />}
                          <button
                            type="button"
                            className="picker-item picker-add"
                            onMouseDown={(e) => { e.preventDefault(); close(); setKeyDrawer({ mode: 'import', forIdentity: true }); }}
                          >
                            + Import key…
                          </button>
                          <button
                            type="button"
                            className="picker-item picker-add"
                            onMouseDown={(e) => { e.preventDefault(); close(); setKeyDrawer({ mode: 'generate', forIdentity: true }); }}
                          >
                            + Generate key…
                          </button>
                        </>
                      )}
                    </PortalDropdown>
                  </div>
                </div>
              ) : (
                <div className="form-group">
                  <PassphraseInput
                    value={idPassword}
                    onChange={setIdPassword}
                    placeholder={editId?.encrypted_password === STORED ? 'leave blank to keep existing' : 'password'}
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
                const isPasswordAuth = !storedless && id.encrypted_password === STORED;
                const key = storedless || isPasswordAuth ? null : keys.find((k) => k.id === id.key_id);
                const keyMissing = !storedless && !isPasswordAuth && !key;
                return (
                  <div key={id.id} className={`kc-card kc-card--clickable${keyMissing ? ' warn' : ''}`} {...clickableProps(() => openEditIdentity(id))} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtxMenu({ x: e.clientX, y: e.clientY, kind: 'identity', id: id.id }); }}>
                    <div className="card-body">
                      <span className="card-title">{id.name}</span>
                      <span className="kc-card-detail">{id.username}</span>
                      <span className="kc-card-detail">
                        {isPromptAuth ? 'prompt' : isAgentAuth ? 'ssh-agent' : isPasswordAuth ? 'password' : key ? key.name : <span className="warn-text">key deleted</span>}
                      </span>
                    </div>
                    <button className="card-edit-btn" onClick={(e) => { e.stopPropagation(); openEditIdentity(id); }} title={hint('Edit')}>
                      <EditIcon />
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
            <button type="submit" form="edit-key-form" className="btn-primary btn-sm" disabled={editKeySaving || editKeyLoading || !!certProblem}>
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
                    <input value={editKeyName} onChange={(e) => setEditKeyName(e.target.value)} placeholder="Key name" autoFocus={!isAndroid} />
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
                        <button type="button" className="btn-secondary btn-sm" onClick={() => void copy(editKeyPublic!, 'edit-pub')}>{copied === 'edit-pub' ? 'Copied' : 'Copy'}</button>
                      </div>
                    </div>
                  )}
                  <div className="form-group">
                    <label>Private key</label>
                    <div className="key-pub-box key-pub-box--tall">
                      <AutoTextarea
                        className="key-paste-area"
                        value={editKeyPrivate}
                        onChange={setEditKeyPrivate}
                        rows={10}
                      />
                      <button type="button" className="btn-secondary btn-sm" onClick={() => void copy(editKeyPrivate, 'edit-key')}>{copied === 'edit-key' ? 'Copied' : 'Copy'}</button>
                    </div>
                  </div>
                  <KeyCertificate
                    keyId={editKeyId}
                    value={editKeyCert}
                    onChange={setEditKeyCert}
                    keyPem={editKeyPrivate}
                    passphrase={editKeyPassphrase}
                    onProblem={setCertProblem}
                  />
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
              <button className="menu-item" onClick={() => { setCtxMenu(null); setKeyDrawer({ mode: 'import', forIdentity: false }); }}>Add Key</button>
              <button className="menu-item" onClick={() => { setCtxMenu(null); setKeyDrawer({ mode: 'generate', forIdentity: false }); }}>Generate Key</button>
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
