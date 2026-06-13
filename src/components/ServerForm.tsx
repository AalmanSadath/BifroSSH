import { useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '../store/appStore';
import ThemePicker, { ThumbNail } from './ThemePicker';
import { THEMES } from '../styles/themes';
import type { Server } from '../types';

const CHEVRON = <svg width="10" height="6" viewBox="0 0 10 6" fill="currentColor"><path d="M0 0l5 6 5-6z"/></svg>;

interface Props {
  server: Server | null;
  onClose: () => void;
  onDelete?: () => void;
}

export default function ServerForm({ server, onClose, onDelete }: Props) {
  const { identities, keys, saveServer, saveIdentity, customThemes, setActiveTab } = useAppStore();

  const initIdentity = server?.identity_id ? identities.find((i) => i.id === server.identity_id) : null;

  const [name, setName] = useState(server?.name ?? '');
  const [host, setHost] = useState(server?.host ?? '');
  const [port, setPort] = useState(server?.port ?? 22);
  const [identityId, setIdentityId] = useState(server?.identity_id ?? '');
  const [username, setUsername] = useState(initIdentity ? '' : '');
  const [password, setPassword] = useState('');
  const [keyId, setKeyId] = useState('');
  const [keyDropdownOpen, setKeyDropdownOpen] = useState(false);
  const [keyDropdownRect, setKeyDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [dropdownRect, setDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const usernameGroupRef = useRef<HTMLDivElement>(null);
  const passwordGroupRef = useRef<HTMLDivElement>(null);
  const keyBtnRef = useRef<HTMLButtonElement>(null);
  const [themeOverride, setThemeOverride] = useState<string>(server?.theme ?? 'bifrossh-dark');
  const [timeoutSecs, setTimeoutSecs] = useState<string>(server?.connection_timeout != null ? String(server.connection_timeout) : '');
  const [themeExpanded, setThemeExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const selectedIdentity = identities.find((i) => i.id === identityId) ?? null;
  const selectedKey = keys.find((k) => k.id === keyId) ?? null;

  const suggestions = identities.filter((i) => {
    if (!username && !password) return false;
    if (username) return i.username.toLowerCase().includes(username.toLowerCase()) || i.name.toLowerCase().includes(username.toLowerCase());
    return true;
  });

  function pickIdentity(id: string) {
    setIdentityId(id);
    setUsername('');
    setPassword('');
    setKeyId('');
    setShowSuggestions(false);
  }

  function removeIdentity() {
    setIdentityId('');
    setUsername('');
    setPassword('');
    setKeyId('');
  }

  function openKeyDropdown() {
    const r = keyBtnRef.current?.getBoundingClientRect();
    if (r) setKeyDropdownRect({ top: r.bottom + 2, left: r.left, width: r.width });
    setKeyDropdownOpen(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !host.trim()) { setError('Name and host are required'); return; }
    setSaving(true);
    setError('');
    try {
      let finalIdentityId = identityId || null;

      if (!identityId && username.trim() && (password.trim() || keyId)) {
        if (keyId) {
          await saveIdentity({
            id: '', name: `${name.trim()} (${username.trim()})`, username: username.trim(), key_id: keyId, encrypted_password: null,
          });
        } else {
          await saveIdentity(
            { id: '', name: `${name.trim()} (${username.trim()})`, username: username.trim(), key_id: null, encrypted_password: null },
            password.trim(),
          );
        }
        const fresh = useAppStore.getState().identities;
        const created = fresh.find((i) => i.username === username.trim() && i.name === `${name.trim()} (${username.trim()})`);
        finalIdentityId = created?.id ?? null;
      }

      const parsed = parseInt(timeoutSecs, 10);
      await saveServer({
        id: server?.id,
        name: name.trim(),
        host: host.trim(),
        port,
        identity_id: finalIdentityId,
        theme: themeOverride as string | null,
        connection_timeout: timeoutSecs.trim() === '' || isNaN(parsed) ? null : Math.max(1, parsed),
      });
      onClose();
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-header">
          <button className="drawer-close" onClick={onClose}>✕</button>
          <span>{server ? 'Edit Host' : 'Add Host'}</span>
          <button type="submit" form="host-form" className="btn-primary btn-sm" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
        <div className="drawer-body">
          <form id="host-form" className="inline-form" onSubmit={handleSubmit}>
            <div className="form-group">
              <label>Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Production Web" autoFocus />
            </div>
            <div className="form-row">
              <div className="form-group flex-1">
                <label>Host</label>
                <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.100" />
              </div>
              <div className="form-group port-group">
                <label>Port</label>
                <input type="number" value={port} min={1} max={65535} onChange={(e) => setPort(Number(e.target.value))} />
              </div>
            </div>

            {selectedIdentity ? (
              <div className="form-group">
                <label>Identity</label>
                <div className="host-identity-badge">
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
                  </svg>
                  <span className="host-identity-badge-name">{selectedIdentity.name}</span>
                  <span className="host-identity-badge-user">{selectedIdentity.username}</span>
                  <button type="button" className="host-identity-badge-remove" onClick={removeIdentity}>✕</button>
                </div>
              </div>
            ) : (
              <>
                <div className="form-group" ref={usernameGroupRef}>
                  <label>Username</label>
                  <input
                    value={username}
                    onChange={(e) => { setUsername(e.target.value); setShowSuggestions(true); }}
                    onFocus={() => {
                      const r = usernameGroupRef.current?.getBoundingClientRect();
                      if (r) setDropdownRect({ top: r.bottom + 2, left: r.left, width: r.width });
                      setShowSuggestions(true);
                    }}
                    onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                    placeholder="ubuntu"
                    autoComplete="off"
                  />
                </div>
                <div className="form-group" ref={passwordGroupRef}>
                  <label>Password</label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => { setPassword(e.target.value); setShowSuggestions(true); }}
                    onFocus={() => {
                      const r = passwordGroupRef.current?.getBoundingClientRect();
                      if (r) setDropdownRect({ top: r.bottom + 2, left: r.left, width: r.width });
                      setShowSuggestions(true);
                    }}
                    onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                    placeholder="leave blank to use key or prompt"
                    autoComplete="new-password"
                  />
                </div>
                <div className="form-group">
                  <label>Key</label>
                  <div className="id-key-picker">
                    <button
                      ref={keyBtnRef}
                      type="button"
                      className="id-key-picker-btn"
                      onClick={openKeyDropdown}
                    >
                      <span>{selectedKey?.name ?? 'Select key…'}</span>
                      {CHEVRON}
                    </button>
                  </div>
                </div>
                {keyDropdownOpen && keyDropdownRect && createPortal(
                  <>
                    <div
                      style={{ position: 'fixed', inset: 0, zIndex: 9998 }}
                      onMouseDown={() => setKeyDropdownOpen(false)}
                    />
                    <div
                      className="id-key-picker-menu"
                      style={{ position: 'fixed', top: keyDropdownRect.top, left: keyDropdownRect.left, width: keyDropdownRect.width, zIndex: 9999 }}
                    >
                      {keys.map((k) => (
                        <button
                          key={k.id}
                          type="button"
                          className={`id-key-picker-item${keyId === k.id ? ' selected' : ''}`}
                          onMouseDown={(e) => { e.preventDefault(); setKeyId(keyId === k.id ? '' : k.id); setKeyDropdownOpen(false); }}
                        >
                          {k.name}
                        </button>
                      ))}
                      {keys.length > 0 && <div className="id-key-picker-divider" />}
                      <button
                        type="button"
                        className="id-key-picker-item id-key-picker-add"
                        onMouseDown={(e) => { e.preventDefault(); setKeyDropdownOpen(false); setActiveTab('keychain'); onClose(); }}
                      >
                        + Add Key…
                      </button>
                    </div>
                  </>,
                  document.body,
                )}
                {showSuggestions && dropdownRect && (() => {
                  const items = suggestions.length > 0 ? suggestions : (!username ? identities : []);
                  if (items.length === 0) return null;
                  return createPortal(
                    <div
                      className="id-key-picker-menu"
                      style={{ position: 'fixed', top: dropdownRect.top, left: dropdownRect.left, width: dropdownRect.width, zIndex: 9999 }}
                    >
                      {items.map((i) => (
                        <button
                          key={i.id}
                          type="button"
                          className="id-key-picker-item"
                          onMouseDown={(e) => { e.preventDefault(); pickIdentity(i.id); }}
                        >
                          {i.name} <span style={{ opacity: 0.6 }}>({i.username})</span>
                          <span className="host-suggestion-type">
                            {i.encrypted_password === '[stored]' ? 'password' : 'key'}
                          </span>
                        </button>
                      ))}
                    </div>,
                    document.body,
                  );
                })()}
              </>
            )}

            <div className="form-group">
              <label>Connection Timeout (seconds)</label>
              <input
                type="number"
                min={1}
                max={3600}
                className="no-spinner"
                value={timeoutSecs}
                onChange={(e) => setTimeoutSecs(e.target.value)}
                placeholder="Global default (60s)"
              />
            </div>
            <div className="form-group">
              <div className="theme-current-row">
                <div className="theme-current-thumb">
                  <ThumbNail id={themeOverride} />
                </div>
                <span className="theme-current-name">{(THEMES[themeOverride] ?? customThemes[themeOverride])?.name ?? themeOverride}</span>
              </div>
              <button
                type="button"
                className="theme-show-more-btn"
                onClick={() => setThemeExpanded((v) => !v)}
              >
                {themeExpanded ? 'Show less ∧' : 'Show more ∨'}
              </button>
              {themeExpanded && (
                <ThemePicker
                  value={themeOverride}
                  onChange={(id) => { setThemeOverride(id); setThemeExpanded(false); }}
                />
              )}
            </div>
            {error && <p className="form-error">{error}</p>}
          </form>
        </div>
        {onDelete && (
          <div className="drawer-footer">
            <button className="btn-danger btn-sm" onClick={onDelete}>Delete Host</button>
          </div>
        )}
      </div>
    </>
  );
}
