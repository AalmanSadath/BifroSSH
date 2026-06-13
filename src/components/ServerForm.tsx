import { useState, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
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
  const { identities, keys, saveServer, customThemes, setActiveTab } = useAppStore();

  const [name, setName] = useState(server?.name ?? '');
  const [host, setHost] = useState(server?.host ?? '');
  const [port, setPort] = useState(server?.port ?? 22);
  const [identityId, setIdentityId] = useState(server?.identity_id ?? '');
  const [username, setUsername] = useState(server?.username ?? '');
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (server?.id && server.encrypted_password === '[stored]') {
      invoke<string>('get_server_password', { serverId: server.id })
        .then(setPassword)
        .catch(() => {});
    }
  }, []);
  const [keyId, setKeyId] = useState(server?.key_id ?? '');
  const [showPassword, setShowPassword] = useState(false);
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
      const parsed = parseInt(timeoutSecs, 10);
      await saveServer(
        {
          id: server?.id,
          name: name.trim(),
          host: host.trim(),
          port,
          identity_id: identityId || null,
          username: (!identityId && username.trim()) ? username.trim() : null,
          encrypted_password: null,
          key_id: (!identityId && keyId) ? keyId : null,
          theme: themeOverride as string | null,
          connection_timeout: timeoutSecs.trim() === '' || isNaN(parsed) ? null : Math.max(1, parsed),
        },
        (!identityId && !keyId && password.trim()) ? password.trim() : undefined,
      );
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
                  <div className="input-with-eye">
                    <input
                      type={showPassword ? 'text' : 'password'}
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
                    <button type="button" className="eye-btn" onClick={() => setShowPassword((v) => !v)} tabIndex={-1}>
                      {showPassword ? (
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                          <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
                          <line x1="1" y1="1" x2="23" y2="23"/>
                        </svg>
                      ) : (
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                          <circle cx="12" cy="12" r="3"/>
                        </svg>
                      )}
                    </button>
                  </div>
                </div>
                <div className="form-group">
                  <label>Key</label>
                  <div className="picker">
                    <button
                      ref={keyBtnRef}
                      type="button"
                      className="picker-btn"
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
                      className="picker-menu"
                      style={{ position: 'fixed', top: keyDropdownRect.top, left: keyDropdownRect.left, width: keyDropdownRect.width, zIndex: 9999 }}
                    >
                      {keys.map((k) => (
                        <button
                          key={k.id}
                          type="button"
                          className={`picker-item${keyId === k.id ? ' selected' : ''}`}
                          onMouseDown={(e) => { e.preventDefault(); setKeyId(keyId === k.id ? '' : k.id); setKeyDropdownOpen(false); }}
                        >
                          {k.name}
                        </button>
                      ))}
                      {keys.length > 0 && <div className="picker-divider" />}
                      <button
                        type="button"
                        className="picker-item picker-add"
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
                      className="picker-menu"
                      style={{ position: 'fixed', top: dropdownRect.top, left: dropdownRect.left, width: dropdownRect.width, zIndex: 9999 }}
                    >
                      {items.map((i) => (
                        <button
                          key={i.id}
                          type="button"
                          className="picker-item"
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
              <label>Connection Attempt Timeout (seconds)</label>
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
        {(onDelete || server) && (
          <div className="drawer-footer">
            {onDelete && <button className="btn-danger btn-sm" onClick={onDelete}>Delete Host</button>}
            {server && (
              <button
                className="btn-primary btn-sm"
                onClick={() => { onClose(); useAppStore.getState().openSession(server.id); }}
              >
                Connect
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
