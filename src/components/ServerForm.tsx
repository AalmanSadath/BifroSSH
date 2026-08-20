import { useState, useRef, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store/appStore';
import ThemePicker, { ThumbNail } from './ThemePicker';
import { THEMES } from '../styles/themes';
import type { Server } from '../types';
import Drawer from './shared/Drawer';
import PortalDropdown, { PortalMenu, anchorBelow, type AnchorRect } from './shared/PortalDropdown';
import PassphraseInput from './shared/PassphraseInput';

interface Props {
  server: Server | null;
  onClose: () => void;
  onDelete?: () => void;
}

export default function ServerForm({ server, onClose, onDelete }: Props) {
  const { servers, identities, keys, saveServer, customThemes, setActiveTab } = useAppStore();

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
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [dropdownRect, setDropdownRect] = useState<AnchorRect | null>(null);
  const usernameGroupRef = useRef<HTMLDivElement>(null);
  const passwordGroupRef = useRef<HTMLDivElement>(null);
  const [themeOverride, setThemeOverride] = useState<string>(server?.theme ?? 'bifrossh-dark');
  const [timeoutSecs, setTimeoutSecs] = useState<string>(server?.connection_timeout != null ? String(server.connection_timeout) : '');
  const [proxyJump, setProxyJump] = useState(server?.proxy_jump ?? '');
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
          // Set on the identity, not here; preserved so editing a host does not clear it.
          auth_kind: server?.auth_kind ?? null,
          proxy_jump: proxyJump || null,
        },
        (!identityId && !keyId && password.trim()) ? password.trim() : undefined,
      );
      onClose();
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  }

  // Offering a host that already reaches this one through its own chain would
  // build a loop the connection could never resolve, so those are left out
  // rather than allowed and rejected at connect time.
  const jumpCandidates = servers.filter((candidate) => {
    if (candidate.id === server?.id) return false;
    // A host being created has nothing pointing at it yet, so no chain
    // through it can exist to loop back.
    if (!server) return true;
    const seen = new Set<string>();
    let hop: Server | undefined = candidate;
    while (hop?.proxy_jump && !seen.has(hop.id)) {
      seen.add(hop.id);
      if (hop.proxy_jump === server.id) return false;
      hop = servers.find((s) => s.id === hop!.proxy_jump);
    }
    return true;
  });

  return (
    <Drawer
      title={server ? 'Edit Host' : 'Add Host'}
      onClose={onClose}
      action={
        <button type="submit" form="host-form" className="btn-primary btn-sm" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      }
    >
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
              <input type="number" className="no-spinner" value={port} min={1} max={65535} onChange={(e) => setPort(Number(e.target.value))} />
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
                <PassphraseInput
                  value={password}
                  onChange={(v) => { setPassword(v); setShowSuggestions(true); }}
                  onFocus={() => {
                    setDropdownRect(anchorBelow(passwordGroupRef.current));
                    setShowSuggestions(true);
                  }}
                  onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
                  placeholder="leave blank to use key or prompt"
                />
              </div>
              <div className="form-group">
                <label>Key</label>
                <div className="picker">
                  <PortalDropdown label={selectedKey?.name ?? 'Select key…'}>
                    {(close) => (
                      <>
                        {keys.map((k) => (
                          <button
                            key={k.id}
                            type="button"
                            className={`picker-item${keyId === k.id ? ' selected' : ''}`}
                            onMouseDown={(e) => { e.preventDefault(); setKeyId(keyId === k.id ? '' : k.id); close(); }}
                          >
                            {k.name}
                          </button>
                        ))}
                        {keys.length > 0 && <div className="picker-divider" />}
                        <button
                          type="button"
                          className="picker-item picker-add"
                          onMouseDown={(e) => { e.preventDefault(); close(); setActiveTab('keychain'); onClose(); }}
                        >
                          + Add Key…
                        </button>
                      </>
                    )}
                  </PortalDropdown>
                </div>
              </div>
              {showSuggestions && dropdownRect && (() => {
                const items = suggestions.length > 0 ? suggestions : (!username ? identities : []);
                if (items.length === 0) return null;
                return (
                  <PortalMenu rect={dropdownRect}>
                    {items.map((i) => (
                      <button
                        key={i.id}
                        type="button"
                        className="picker-item"
                        onMouseDown={(e) => { e.preventDefault(); pickIdentity(i.id); }}
                      >
                        {i.name} <span style={{ opacity: 0.6 }}>({i.username})</span>
                        <span className="host-suggestion-type">
                          {i.auth_kind === 'keyboard-interactive'
                            ? 'prompt'
                            : i.auth_kind === 'agent'
                              ? 'ssh-agent'
                              : i.encrypted_password === '[stored]' ? 'password' : 'key'}
                        </span>
                      </button>
                    ))}
                  </PortalMenu>
                );
              })()}
            </>
          )}

          <div className="form-group">
            <label>Jump Host</label>
            <select value={proxyJump} onChange={(e) => setProxyJump(e.target.value)}>
              <option value="">Connect directly</option>
              {jumpCandidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name} ({candidate.host})
                </option>
              ))}
            </select>
            <p className="form-hint">
              Reach this host through another saved host, the way ssh does with
              ProxyJump. The jump host connects with its own credentials, and its
              own jump host is followed too.
            </p>
          </div>

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
    </Drawer>
  );
}
