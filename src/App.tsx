import { useEffect, useMemo, useState, useRef } from 'react';
import * as ipc from './ipc';
import { listen } from '@tauri-apps/api/event';
import { useAppStore, resolveAccent, resolveAppTheme } from './store/appStore';
import { accentTokens } from './styles/accent';
import { setLocalPlatform } from './paths';
import { useIdleLock } from './hooks/useIdleLock';
import type { AuthPromptEvent, HostKeyPromptEvent, SessionTab, SystemAppearance, VaultStatus } from './types';
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
import Modal from './components/shared/Modal';
import PassphraseInput from './components/shared/PassphraseInput';
import PortalDropdown from './components/shared/PortalDropdown';

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
    loadAll, loadError, actionError, setActionError, sessions, activeTabId, setActiveTab, removeSession,
    renameSession, openSession, quickConnect, servers, settings, keys,
    systemAppearance, setSystemAppearance, clearForLock,
  } = useAppStore();

  const resolvedTheme = resolveAppTheme(settings.app_theme, systemAppearance);
  const accent = resolveAccent(settings, systemAppearance);

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
    ipc.vaultStatus()
      .then((v) => {
        setVault(v);
        if (!v.locked) loadAll();
      })
      .catch(() => setVault({ locked: false, setup_required: false, keyring_available: false, keyring_locked: false, error: null }));
    // `loadAll` is a store action, created once with the store, so naming it
    // does not make this run again.
  }, [loadAll]);

  const opened = () => {
    setVault({ locked: false, setup_required: false, keyring_available: false, keyring_locked: false, error: null });
    loadAll();
  };

  /**
   * Asks the backend to close the vault. The shortcut and the idle timeout
   * come here; the settings button calls the same command. What happens on
   * this side happens in the `vault-locked` listener below, which is also
   * how a lock the backend started on its own, before sleep, arrives. One
   * path for every way of locking.
   */
  const lockNow = () =>
    ipc.lockVault().catch((e) => {
      // No passphrase set, which the settings screen explains at length. Said
      // once here so a shortcut that did nothing is not a mystery.
      setActionError(String(e));
    });

  // The vault is closed, whoever closed it. The backend has dropped the key
  // and the data; this drops the copies and shows the unlock screen.
  // Sessions stay, their shells still running behind it.
  useEffect(() => {
    const unlisten = listen('vault-locked', () => {
      clearForLock();
      setVault((v) => ({
        ...(v ?? { setup_required: false, keyring_available: false, keyring_locked: false, error: null }),
        locked: true,
      }));
    });
    return () => { unlisten.then((f) => f()); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Ctrl+Shift+L. The terminal passes every Ctrl+Shift chord but F, C and V
  // through, and the file list's Ctrl+L has no shift, so nothing else wants
  // this. Capture phase so no handler below can take it first.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.code === 'KeyL') {
        e.preventDefault();
        e.stopPropagation();
        void lockNow();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useIdleLock(vault && !vault.locked ? settings.auto_lock_minutes : 0, () => { void lockNow(); });

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

  // Asked once and never again: local paths are separated differently on
  // Windows, and every breadcrumb and rename target is built from that. Before
  // the answer arrives the app assumes POSIX, which is what it always did.
  useEffect(() => {
    ipc.platform().then(setLocalPlatform).catch(() => {});
  }, []);

  // Asked once at startup, then followed: the system reports a desktop that
  // changes its mind, so a theme set to system switches without a restart.
  useEffect(() => {
    ipc.systemAppearance().then(setSystemAppearance).catch(() => {});
    const unlisten = listen<SystemAppearance>(
      'system-appearance-changed',
      (e) => setSystemAppearance(e.payload),
    );
    return () => { unlisten.then((fn) => fn()); };
  }, [setSystemAppearance]);

  useEffect(() => {
    const body = document.body;
    body.classList.remove('app-light', 'app-amoled');
    if (resolvedTheme === 'light') body.classList.add('app-light');
    else if (resolvedTheme === 'amoled') body.classList.add('app-amoled');
  }, [resolvedTheme]);

  /**
   * The accent overrides the palette's own, as three properties rather than
   * one. A colour needs a foreground that stays legible on it and a hover a
   * shade along, and both were hand-picked per theme against a known accent.
   *
   * Written onto the same elements that carry the theme class, not onto
   * <html>. Custom properties inherit, so the nearest declaration wins, and
   * the light and amoled palettes redeclare --accent on body and on .app
   * below it: an override on the root was shadowed by both, which is why only
   * the dark theme, the one declared on bare :root, appeared to follow.
   *
   * Portals render into body rather than into .app, so both need it.
   */
  // Memoised on the colour itself: a fresh object each render would restyle
  // the body on every one.
  const accentVars = useMemo(() => {
    const tokens = accent ? accentTokens(accent) : null;
    return tokens
      ? ({
          '--accent': tokens.accent,
          '--accent-hover': tokens.accentHover,
          '--on-accent': tokens.onAccent,
        } as React.CSSProperties)
      : undefined;
  }, [accent]);

  useEffect(() => {
    const { style } = document.body;
    // Removed rather than set to a default when there is nothing to apply, so
    // whichever palette is in force goes back to the values it ships with.
    for (const [name, value] of Object.entries(accentVars ?? {})) {
      style.setProperty(name, value as string);
    }
    if (!accentVars) {
      for (const name of ['--accent', '--accent-hover', '--on-accent']) {
        style.removeProperty(name);
      }
    }
  }, [accentVars]);

  useEffect(() => {
    if (tabCtx?.mode === 'rename') renameInputRef.current?.select();
  }, [tabCtx?.mode]);

  function handleCloseTab(tabId: string, e: React.MouseEvent) {
    e.stopPropagation();
    const session = sessions.find((s) => s.tab_id === tabId);
    // A dropped tab has no session to close; the store entry is all there is.
    if (session?.session_id) ipc.sshDisconnect(session.session_id).catch(() => {});
    removeSession(tabId);
  }

  // Read through a ref by the key handler below, which is bound once and
  // would otherwise see the sessions and active tab of its first render.
  const tabsRef = useRef({ sessions, activeTabId });
  tabsRef.current = { sessions, activeTabId };

  /**
   * Tab keys. Cycling is over session tabs only, in strip order, wrapping;
   * from a fixed tab, next lands on the first session and previous on the
   * last. Capture phase on the window, and the event is stopped there, not
   * just defaulted: xterm's key handler does not look at defaultPrevented,
   * and let through it turned Ctrl+PageUp into the shell receiving "5~".
   *
   * Ctrl+W is left alone: it is readline's delete-word, and every shell
   * wants it. Ctrl+Shift+W is what GNOME Terminal uses for the same reason.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      const { sessions: tabs, activeTabId: active } = tabsRef.current;
      const idx = tabs.findIndex((t) => t.tab_id === active);

      const next = e.code === 'Tab' && !e.shiftKey || e.code === 'PageDown';
      const prev = e.code === 'Tab' && e.shiftKey || e.code === 'PageUp';
      if (next || prev) {
        e.preventDefault();
        e.stopPropagation();
        if (tabs.length === 0) return;
        const target = idx < 0
          ? (next ? 0 : tabs.length - 1)
          : (idx + (next ? 1 : tabs.length - 1)) % tabs.length;
        setActiveTab(tabs[target].tab_id);
        return;
      }
      if (e.shiftKey && e.code === 'KeyT') {
        e.preventDefault();
        e.stopPropagation();
        const current = idx >= 0 ? tabs[idx] : undefined;
        // A quick connection has no host record to open again.
        if (current && current.server_id) openSession(current.server_id);
        return;
      }
      if (e.shiftKey && e.code === 'KeyW') {
        e.preventDefault();
        e.stopPropagation();
        // Not closeTab: that reads `sessions` from the render it was made
        // in, and this listener was made once. The tab from the ref is the
        // live one.
        const current = idx >= 0 ? tabs[idx] : undefined;
        if (!current) return;
        if (current.session_id) ipc.sshDisconnect(current.session_id).catch(() => {});
        removeSession(current.tab_id);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    if (name) renameSession(tabCtx.session.tab_id, name);
    setTabCtx(null);
  }

  // Held back until vault_status answers, which is one synchronous read on the
  // backend, so this is a frame rather than a spinner's worth of waiting.
  if (!vault) return null;
  // Nothing behind the screen yet, or nothing that can be shown: the screen
  // is all there is.
  if (vault.error || vault.setup_required || (vault.locked && sessions.length === 0)) {
    return (
      <div
        className={`app${resolvedTheme === 'light' ? ' app-light' : resolvedTheme === 'amoled' ? ' app-amoled' : ''}`}
        style={accentVars}
      >
        {vault.setup_required ? (
          <FirstRunSetup keyringAvailable={vault.keyring_available} onReady={opened} />
        ) : (
          <UnlockScreen fatal={vault.error} keyringLocked={vault.keyring_locked} onUnlocked={opened} />
        )}
      </div>
    );
  }

  return (
    <div
      className={`app${resolvedTheme === 'light' ? ' app-light' : resolvedTheme === 'amoled' ? ' app-amoled' : ''}`}
      style={accentVars}
    >
      {/* A lock with sessions open covers the app rather than replacing it,
          so the terminals stay mounted: unmounting one disposes its xterm and
          the scrollback with it, and drops its output listener, so nothing
          the shell printed during the lock would be seen. The overlay is
          opaque and takes every pointer event; the unlock field has focus. */}
      {vault.locked && (
        <div className="lock-overlay">
          <UnlockScreen fatal={null} keyringLocked={vault.keyring_locked} onUnlocked={opened} />
        </div>
      )}
      {/* Inert while locked: without it, Tab from the passphrase field walks
          into the sidebar behind the overlay and Enter presses whatever it
          lands on. `display: contents` keeps the flex layout the two children
          were laid out by. */}
      <div className="app-body" inert={vault.locked || undefined}>
      <Sidebar />
      <div className="main">
        {loadError && (
          <div className="load-error-banner">
            <span>
              Saved data could not be read, so this may not be showing everything.
              {' '}{loadError}
            </span>
            <button className="btn-secondary btn-sm" onClick={() => loadAll()}>Try again</button>
          </div>
        )}
        {actionError && (
          <div className="load-error-banner">
            <span>{actionError}</span>
            <button
              className="load-error-dismiss"
              aria-label="Dismiss"
              onClick={() => setActionError(null)}
            >
              ✕
            </button>
          </div>
        )}
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
        {/* Always rendered, empty or not. Appearing on the first connect, it
            pushed everything below it down the page. */}
        <div className={`tab-bar${sessions.length === 0 ? ' tab-bar-empty' : ''}`}>
          {sessions.map((s) => (
              <div
                key={s.tab_id}
                className={`tab ${activeTabId === s.tab_id ? 'tab-active' : ''}`}
                onClick={() => setActiveTab(s.tab_id)}
                onContextMenu={(e) => handleTabContextMenu(e, s)}
              >
                <span className="tab-title">{s.server_name}</span>
                <button className="tab-close" onClick={(e) => handleCloseTab(s.tab_id, e)}>&#10005;</button>
              </div>
            ))}
            {sessions.some((s) => s.tab_id === activeTabId) && (
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

        <div className="content">
          <div className="content-main">
          {sessions.map((s) => {
            const server = servers.find((srv) => srv.id === s.server_id)
              ?? (s.quick_info ? {
                id: '', name: s.server_name,
                host: s.quick_info.host, port: s.quick_info.port,
                identity_id: null, theme: null, connection_timeout: null, os: '',
                username: s.quick_info.username, encrypted_password: null, key_id: null,
                auth_kind: null, proxy_jump: null, forward_agent: false,
              } : undefined);

            if (s.status === 'connecting' || s.status === 'error') {
              if (!server) return null;
              return (
                <div key={s.tab_id} style={{ display: activeTabId === s.tab_id ? 'contents' : 'none' }}>
                  <ConnectingView
                    server={server}
                    logs={s.logs ?? []}
                    error={s.error}
                    onClose={() => removeSession(s.tab_id)}
                    onRetry={s.quick_info ? undefined : () => { removeSession(s.tab_id); openSession(s.server_id); }}
                    onEditHost={s.quick_info ? undefined : () => setEditServerId(server.id)}
                  />
                </div>
              );
            }

            return (
              <TerminalView
                key={s.tab_id}
                tab={s}
                active={activeTabId === s.tab_id}
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
          {termSidebarOpen && sessions.some((s) => s.tab_id === activeTabId) && (
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
        <Modal
          title={`${quickParsed.user}@${quickParsed.host}${quickParsed.port !== 22 ? `:${quickParsed.port}` : ''}`}
          className="quick-auth-modal"
          onClose={() => setQuickParsed(null)}
        >
          <div className="form-group">
            <label>Password</label>
            <PassphraseInput
              inputRef={quickPasswordRef}
              value={quickPassword}
              onChange={(v) => { setQuickPassword(v); if (v) setQuickKeyId(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') submitQuickAuth(); if (e.key === 'Escape') setQuickParsed(null); }}
              placeholder="SSH password"
              disabled={!!quickKeyId}
            />
          </div>
          <div className="quick-auth-or">or use a stored key</div>
          <div className="picker quick-auth-keys">
            <PortalDropdown label={keys.find((k) => k.id === quickKeyId)?.name ?? 'Select key…'}>
              {(close) => (
                <>
                  {keys.map((k) => (
                    <button
                      key={k.id}
                      type="button"
                      className={`picker-item${quickKeyId === k.id ? ' selected' : ''}`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setQuickKeyId(quickKeyId === k.id ? '' : k.id);
                        setQuickPassword('');
                        close();
                      }}
                    >
                      {k.name}
                    </button>
                  ))}
                  {keys.length === 0 && <div className="picker-empty">No keys stored</div>}
                </>
              )}
            </PortalDropdown>
          </div>
          <div className="modal-actions">
            <button className="btn-secondary btn-sm" onClick={() => setQuickParsed(null)}>Cancel</button>
            <button className="btn-primary btn-sm" onClick={submitQuickAuth} disabled={!quickPassword && !quickKeyId}>Connect</button>
          </div>
        </Modal>
      )}

      {tabCtx && (
        <ContextMenu x={tabCtx.x} y={tabCtx.y} onClose={() => setTabCtx(null)}>
          {tabCtx.mode === 'menu' ? (
            <>
              <button className="menu-item" onClick={() => handleDuplicate(tabCtx.session)}>
                Duplicate
              </button>
              <button className="menu-item" onClick={() => setTabCtx({ ...tabCtx, mode: 'rename' })}>
                Rename
              </button>
              <div className="menu-divider" />
              <button className="menu-item menu-item-danger" onClick={(e) => { handleCloseTab(tabCtx.session.tab_id, e); setTabCtx(null); }}>
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
              <button className="menu-item" onClick={commitRename}>OK</button>
            </div>
          )}
        </ContextMenu>
      )}
      </div>
    </div>
  );
}
