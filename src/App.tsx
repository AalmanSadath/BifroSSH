import { useEffect, useState, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from './store/appStore';
import type { SessionTab } from './types';
import Sidebar from './components/Sidebar';
import TerminalView from './components/TerminalView';
import ConnectingView from './components/ConnectingView';
import HostsPanel from './components/HostsPanel';
import KeychainPanel from './components/KeychainPanel';
import SettingsPanel from './components/SettingsPanel';
import ThemeEditorPanel from './components/ThemeEditorPanel';
import SftpPanel from './components/SftpPanel';
import ServerForm from './components/ServerForm';

export default function App() {
  const {
    loadAll, sessions, activeTabId, setActiveTab, removeSession,
    renameSession, openSession, servers, settings,
  } = useAppStore();

  const [editServerId, setEditServerId] = useState<string | null>(null);
  type TabCtxMode = 'menu' | 'rename';
  const [tabCtx, setTabCtx] = useState<{ x: number; y: number; session: SessionTab; mode: TabCtxMode } | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const tabCtxRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { loadAll(); }, []);

  useEffect(() => {
    const body = document.body;
    body.classList.remove('app-light', 'app-amoled');
    if (settings.app_theme === 'light') body.classList.add('app-light');
    else if (settings.app_theme === 'amoled') body.classList.add('app-amoled');
  }, [settings.app_theme]);

  useEffect(() => {
    if (!tabCtx) return;
    function onDown(e: MouseEvent) {
      if (!tabCtxRef.current?.contains(e.target as Node)) setTabCtx(null);
    }
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [tabCtx]);

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

  function commitRename() {
    if (!tabCtx) return;
    const name = renameValue.trim();
    if (name) renameSession(tabCtx.session.session_id, name);
    setTabCtx(null);
  }

  return (
    <div className={`app${settings.app_theme === 'light' ? ' app-light' : settings.app_theme === 'amoled' ? ' app-amoled' : ''}`}>
      <Sidebar />
      <div className="main">
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
          </div>
        )}

        <div className="content">
          {sessions.map((s) => {
            const server = servers.find((srv) => srv.id === s.server_id);

            if (s.status === 'connecting' || s.status === 'error') {
              if (!server) return null;
              return (
                <div key={s.session_id} style={{ display: activeTabId === s.session_id ? 'contents' : 'none' }}>
                  <ConnectingView
                    tabId={s.session_id}
                    server={server}
                    error={s.error}
                    onRetry={() => openSession(s.server_id)}
                    onEditHost={() => setEditServerId(server.id)}
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
          {activeTabId === 'settings' && <SettingsPanel />}
          {activeTabId === 'theme-editor' && <ThemeEditorPanel />}
        </div>
      </div>

      {editServerId && (
        <ServerForm
          server={servers.find((s) => s.id === editServerId) ?? null}
          onClose={() => setEditServerId(null)}
        />
      )}

      {tabCtx && (
        <div
          ref={tabCtxRef}
          className="host-context-menu"
          style={{
            top: Math.min(tabCtx.y, window.innerHeight - 130),
            left: Math.min(tabCtx.x, window.innerWidth - 170),
          }}
        >
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
        </div>
      )}
    </div>
  );
}
