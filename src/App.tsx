import { useEffect, useState, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useAppStore } from './store/appStore';
import type { AuthPromptEvent, HostKeyPromptEvent, SessionTab, VaultStatus } from './types';
import HostKeyPrompt from './components/HostKeyPrompt';
import AuthPromptModal from './components/AuthPromptModal';
import Sidebar from './components/Sidebar';
import UnlockScreen from './components/UnlockScreen';
import FirstRunSetup from './components/FirstRunSetup';
import TerminalView from './components/TerminalView';
import ConnectingView from './components/ConnectingView';
import HostsPanel from './components/HostsPanel';
import KeychainPanel from './components/KeychainPanel';
import KnownHostsPanel from './components/KnownHostsPanel';
import SettingsPanel from './components/SettingsPanel';
import ThemeEditorPanel from './components/ThemeEditorPanel';
import SftpPanel from './components/SftpPanel';
import ServerForm from './components/ServerForm';
import TerminalSidebar from './components/TerminalSidebar';
import PortForwardingPanel from './components/PortForwardingPanel';
import ContextMenu from './components/shared/ContextMenu';

function parseSSHInput(input: string): { user: string; host: string; port: number; password?: string } | null {
  let s = input.trim();
  if (s.toLowerCase().startsWith('ssh ')) s = s.slice(4).trim();
  if (!s) return null;

  let port = 22;
  let password: string | undefined;
  const tokens = s.split(/\s+/);
  const remaining: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if ((t === '-p' || t === '--port') && tokens[i + 1]) {
      port = parseInt(tokens[++i], 10) || 22;
    } else if (/^-p\d+$/.test(t)) {
      port = parseInt(t.slice(2), 10) || 22;
    } else if ((t === '-pw' || t === '--password') && tokens[i + 1]) {
      password = tokens[++i];
    } else if (t.startsWith('-pw') && t.length > 3) {
      password = t.slice(3);
    } else {
      remaining.push(t);
    }
  }

  const dest = remaining.find((t) => t.includes('@'));
  if (!dest) return null;
  const atIdx = dest.indexOf('@');
  const user = dest.slice(0, atIdx);
  const host = dest.slice(atIdx + 1);
  if (!user || !host) return null;
  return { user, host, port, password };
}

export default function App() {
  const {
    loadAll, sessions, activeTabId, setActiveTab, removeSession,
    renameSession, openSession, quickConnect, servers, settings, keys,
  } = useAppStore();

  const [editServerId, setEditServerId] = useState<string | null>(null);
  const [quickInput, setQuickInput] = useState('');
  const [quickParsed, setQuickParsed] = useState<{ user: string; host: string; port: number } | null>(null);
  const [quickPassword, setQuickPassword] = useState('');
  const [quickKeyId, setQuickKeyId] = useState('');
  const quickPasswordRef = useRef<HTMLInputElement>(null);
  type TabCtxMode = 'menu' | 'rename';
  const [termSidebarOpen, setTermSidebarOpen] = useState(false);
  const [tabCtx, setTabCtx] = useState<{ x: number; y: number; session: SessionTab; mode: TabCtxMode } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  const [hostKeyPrompts, setHostKeyPrompts] = useState<HostKeyPromptEvent[]>([]);
  const [authPrompts, setAuthPrompts] = useState<AuthPromptEvent[]>([]);

  // Nothing is loaded until the vault is open. While locked the backend holds
  // no key, so loadAll would fail on every call anyway; gating it here keeps
  // the unlock screen from flashing a half populated app behind itself.
  const [vault, setVault] = useState<VaultStatus | null>(null);

  useEffect(() => {
    invoke<VaultStatus>('vault_status')
      .then((v) => {
        setVault(v);
        if (!v.locked) loadAll();
      })
      .catch(() => setVault({ locked: false, setup_required: false, keyring_available: false, keyring_locked: false, error: null }));
  }, []);

  const opened = () => {
    setVault({ locked: false, setup_required: false, keyring_available: false, keyring_locked: false, error: null });
    loadAll();
  };

  // Host key prompts are emitted globally rather than per-connect, so this one
  // modal serves terminal sessions, SFTP, tunnels and OS detection alike.
  useEffect(() => {
    const dismiss = (requestId: string) =>
      setHostKeyPrompts((q) => q.filter((p) => p.request_id !== requestId));

    const unlisten = Promise.all([
      listen<HostKeyPromptEvent>('host-key-prompt', (e) => {
        setHostKeyPrompts((q) =>
          q.some((p) => p.request_id === e.payload.request_id) ? q : [...q, e.payload],
        );
      }),
      // The connect gave up (timed out, or was cancelled) before the user
      // answered — retract the modal instead of leaving it pointing at nothing.
      listen<{ request_id: string }>('host-key-prompt-cancel', (e) => dismiss(e.payload.request_id)),
    ]);

    return () => {
      unlisten.then((fns) => fns.forEach((fn) => fn()));
    };
  }, []);

  // Keyboard-interactive rounds (PAM, 2FA). Same global pattern as above.
  useEffect(() => {
    const dismiss = (requestId: string) =>
      setAuthPrompts((q) => q.filter((p) => p.request_id !== requestId));

    const unlisten = Promise.all([
      listen<AuthPromptEvent>('auth-prompt', (e) => {
        setAuthPrompts((q) =>
          q.some((p) => p.request_id === e.payload.request_id) ? q : [...q, e.payload],
        );
      }),
      listen<{ request_id: string }>('auth-prompt-cancel', (e) => dismiss(e.payload.request_id)),
    ]);

    return () => {
      unlisten.then((fns) => fns.forEach((fn) => fn()));
    };
  }, []);

  useEffect(() => {
    const body = document.body;
    body.classList.remove('app-light', 'app-amoled');
    if (settings.app_theme === 'light') body.classList.add('app-light');
    else if (settings.app_theme === 'amoled') body.classList.add('app-amoled');
  }, [settings.app_theme]);

  useEffect(() => {
    if (tabCtx?.mode === 'rename') renameInputRef.current?.select();
  }, [tabCtx?.mode]);

  function handleCloseTab(sessionId: string, e: React.MouseEvent) {
    e.stopPropagation();
    const session = sessions.find((s) => s.session_id === sessionId);
    if (session?.status === 'connected') invoke('ssh_disconnect', { sessionId }).catch(() => {});
    removeSession(sessionId);
  }

  function handleTabContextMenu(e: React.MouseEvent, session: SessionTab) {
    e.preventDefault();
    e.stopPropagation();
    setRenameValue(session.server_name);
    setTabCtx({ x: e.clientX, y: e.clientY, session, mode: 'menu' });
  }

  function handleDuplicate(session: SessionTab) {
    setTabCtx(null);
    openSession(session.server_id);
  }

  function handleQuickSubmit(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return;
    const parsed = parseSSHInput(quickInput);
    if (!parsed) return;
    if (parsed.password) {
      setQuickInput('');
      quickConnect(parsed.host, parsed.port, parsed.user, 'password', parsed.password);
    } else {
      setQuickParsed({ user: parsed.user, host: parsed.host, port: parsed.port });
      setQuickPassword('');
      setQuickKeyId('');
      setTimeout(() => quickPasswordRef.current?.focus(), 50);
    }
  }

  function submitQuickAuth() {
    if (!quickParsed) return;
    const authType = quickKeyId ? 'key' : 'password';
    const authValue = quickKeyId || quickPassword;
    if (!authValue) return;
    setQuickParsed(null);
    setQuickInput('');
    quickConnect(quickParsed.host, quickParsed.port, quickParsed.user, authType, authValue);
  }

  function commitRename() {
    if (!tabCtx) return;
    const name = renameValue.trim();
    if (name) renameSession(tabCtx.session.session_id, name);
    setTabCtx(null);
  }

  // Held back until vault_status answers, which is one synchronous read on the
  // backend, so this is a frame rather than a spinner's worth of waiting.
  if (!vault) return null;
  if (vault.locked || vault.error) {
    return (
      <div className={`app${settings.app_theme === 'light' ? ' app-light' : settings.app_theme === 'amoled' ? ' app-amoled' : ''}`}>
        {vault.setup_required ? (
          <FirstRunSetup keyringAvailable={vault.keyring_available} onReady={opened} />
        ) : (
          <UnlockScreen fatal={vault.error} keyringLocked={vault.keyring_locked} onUnlocked={opened} />
        )}
      </div>
    );
  }

  return (
    <div className={`app${settings.app_theme === 'light' ? ' app-light' : settings.app_theme === 'amoled' ? ' app-amoled' : ''}`}>
      <Sidebar />
      <div className="main">
        {(activeTabId === 'hosts' || activeTabId === null) && <div className="quick-connect-bar">

          <input
            className="quick-connect-input"
            value={quickInput}
            onChange={(e) => setQuickInput(e.target.value)}
            onKeyDown={handleQuickSubmit}
            placeholder="ssh user@host -p 22 -pw password"
            spellCheck={false}
            autoComplete="off"
          />
          <button
            className="btn-primary btn-sm"
            onClick={() => handleQuickSubmit({ key: 'Enter' } as React.KeyboardEvent<HTMLInputElement>)}
          >
            Quick Connect
          </button>
        </div>}
        {sessions.length > 0 && (
          <div className="tab-bar">
            {sessions.map((s) => (
              <div
                key={s.session_id}
                className={`tab ${activeTabId === s.session_id ? 'tab-active' : ''}`}
                onClick={() => setActiveTab(s.session_id)}
                onContextMenu={(e) => handleTabContextMenu(e, s)}
              >
                <span className="tab-title">{s.server_name}</span>
                <button className="tab-close" onClick={(e) => handleCloseTab(s.session_id, e)}>&#10005;</button>
              </div>
            ))}
            {sessions.some((s) => s.session_id === activeTabId) && (
              <button
                className={`tab-sidebar-toggle${termSidebarOpen ? ' active' : ''}`}
                onClick={() => setTermSidebarOpen((v) => !v)}
                title="Toggle terminal sidebar"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2"/>
                  <line x1="15" y1="3" x2="15" y2="21"/>
                </svg>
              </button>
            )}
          </div>
        )}

        <div className="content">
          <div className="content-main">
          {sessions.map((s) => {
            const server = servers.find((srv) => srv.id === s.server_id)
              ?? (s.quick_info ? {
                id: '', name: s.server_name,
                host: s.quick_info.host, port: s.quick_info.port,
                identity_id: null, theme: null, connection_timeout: null, os: '',
                username: s.quick_info.username, encrypted_password: null, key_id: null,
                auth_kind: null, proxy_jump: null,
              } : undefined);

            if (s.status === 'connecting' || s.status === 'error') {
              if (!server) return null;
              return (
                <div key={s.session_id} style={{ display: activeTabId === s.session_id ? 'contents' : 'none' }}>
                  <ConnectingView
                    server={server}
                    logs={s.logs ?? []}
                    error={s.error}
                    onClose={() => removeSession(s.session_id)}
                    onRetry={s.quick_info ? undefined : () => { removeSession(s.session_id); openSession(s.server_id); }}
                    onEditHost={s.quick_info ? undefined : () => setEditServerId(server.id)}
                  />
                </div>
              );
            }

            return (
              <TerminalView
                key={s.session_id}
                sessionId={s.session_id}
                serverId={s.server_id}
                active={activeTabId === s.session_id}
              />
            );
          })}

          {(activeTabId === 'hosts' || activeTabId === null) && <HostsPanel />}
          {activeTabId === 'keychain' && <KeychainPanel />}
          <div style={{ display: activeTabId === 'sftp' ? 'contents' : 'none' }}><SftpPanel /></div>
          {activeTabId === 'knownhosts' && <KnownHostsPanel />}
          {activeTabId === 'portforwarding' && <PortForwardingPanel />}
          {activeTabId === 'settings' && <SettingsPanel />}
          {activeTabId === 'theme-editor' && <ThemeEditorPanel />}
          </div>
          {termSidebarOpen && sessions.some((s) => s.session_id === activeTabId) && (
            <TerminalSidebar activeSessionId={activeTabId} />
          )}
        </div>
      </div>

      {editServerId && (
        <ServerForm
          server={servers.find((s) => s.id === editServerId) ?? null}
          onClose={() => setEditServerId(null)}
        />
      )}

      {hostKeyPrompts.length > 0 && (
        <HostKeyPrompt
          key={hostKeyPrompts[0].request_id}
          event={hostKeyPrompts[0]}
          onResolved={(id) =>
            setHostKeyPrompts((q) => q.filter((p) => p.request_id !== id))
          }
        />
      )}

      {/* Host key first: it decides whether to talk to this server at all. */}
      {hostKeyPrompts.length === 0 && authPrompts.length > 0 && (
        <AuthPromptModal
          key={authPrompts[0].request_id}
          event={authPrompts[0]}
          onResolved={(id) => setAuthPrompts((q) => q.filter((p) => p.request_id !== id))}
        />
      )}

      {quickParsed && (
        <>
          <div className="drawer-backdrop" onClick={() => setQuickParsed(null)} />
          <div className="quick-auth-modal">
            <div className="quick-auth-target">{quickParsed.user}@{quickParsed.host}{quickParsed.port !== 22 ? `:${quickParsed.port}` : ''}</div>
            <div className="form-group" style={{ marginBottom: 10 }}>
              <label>Password</label>
              <input
                ref={quickPasswordRef}
                type="password"
                value={quickPassword}
                onChange={(e) => { setQuickPassword(e.target.value); if (e.target.value) setQuickKeyId(''); }}
                onKeyDown={(e) => { if (e.key === 'Enter') submitQuickAuth(); if (e.key === 'Escape') setQuickParsed(null); }}
                placeholder="SSH password"
                autoComplete="new-password"
                disabled={!!quickKeyId}
              />
            </div>
            <div className="quick-auth-or">or use a stored key</div>
            <div className="picker" style={{ marginBottom: 14 }}>
              <div className="picker-btn" style={{ cursor: 'default' }}>
                <span>{keys.find((k) => k.id === quickKeyId)?.name ?? 'Select key…'}</span>
              </div>
              <div className="picker-menu" style={{ position: 'static', boxShadow: 'none', border: '1px solid var(--border)', marginTop: 4 }}>
                {keys.map((k) => (
                  <button
                    key={k.id}
                    type="button"
                    className={`picker-item${quickKeyId === k.id ? ' selected' : ''}`}
                    onClick={() => { setQuickKeyId(quickKeyId === k.id ? '' : k.id); setQuickPassword(''); }}
                  >
                    {k.name}
                  </button>
                ))}
                {keys.length === 0 && <div style={{ padding: '6px 10px', opacity: 0.5, fontSize: 12 }}>No keys stored</div>}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn-secondary btn-sm" onClick={() => setQuickParsed(null)}>Cancel</button>
              <button className="btn-primary btn-sm" onClick={submitQuickAuth} disabled={!quickPassword && !quickKeyId}>Connect</button>
            </div>
          </div>
        </>
      )}

      {tabCtx && (
        <ContextMenu x={tabCtx.x} y={tabCtx.y} onClose={() => setTabCtx(null)}>
          {tabCtx.mode === 'menu' ? (
            <>
              <button className="host-ctx-item" onClick={() => handleDuplicate(tabCtx.session)}>
                Duplicate
              </button>
              <button className="host-ctx-item" onClick={() => setTabCtx({ ...tabCtx, mode: 'rename' })}>
                Rename
              </button>
              <div className="host-ctx-divider" />
              <button className="host-ctx-item host-ctx-danger" onClick={(e) => { handleCloseTab(tabCtx.session.session_id, e); setTabCtx(null); }}>
                Close Connection
              </button>
            </>
          ) : (
            <div className="tab-ctx-rename">
              <input
                ref={renameInputRef}
                className="tab-rename-input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setTabCtx(null); }}
                autoFocus
              />
              <button className="host-ctx-item" onClick={commitRename}>OK</button>
            </div>
          )}
        </ContextMenu>
      )}
    </div>
  );
}
