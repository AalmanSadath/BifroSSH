import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store/appStore';
import type { Server } from '../types';
import ServerForm from './ServerForm';
import ConnectDialog from './ConnectDialog';
import OsIcon from './OsIcon';

export default function HostsPanel() {
  const { servers, sessions, setActiveTab, removeSession, deleteServer, identities, addSession, detectServerOs } = useAppStore();
  const [showServerForm, setShowServerForm] = useState(false);
  const [editServer, setEditServer] = useState<Server | null>(null);
  const [connectServer, setConnectServer] = useState<Server | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; server: Server } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  const connectedIds = new Set(sessions.map((s) => s.server_id));

  useEffect(() => {
    if (!contextMenu) return;
    function onClickOutside(e: MouseEvent) {
      if (!contextMenuRef.current?.contains(e.target as Node)) setContextMenu(null);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [contextMenu]);

  async function openSession(server: Server) {
    const identity = identities.find((i) => i.id === server.identity_id);
    if (!identity) { setConnectServer(server); return; }

    setConnectingId(server.id);
    setConnectError('');
    try {
      const sessionId = await invoke<string>('ssh_connect', {
        request: {
          server_id: server.id,
          username: identity.username,
          auth_type: 'key',
          auth_value: identity.key_id,
          cols: 80,
          rows: 24,
        },
      });
      const existing = sessions.filter((s) => s.server_id === server.id).length;
      const tabName = existing === 0 ? server.name : `${server.name} (${existing})`;
      addSession({ session_id: sessionId, server_name: tabName, server_id: server.id });
      if (server.os === '') detectServerOs(server.id, identity.username, 'key', identity.key_id);
    } catch (err) {
      setConnectError(String(err));
    } finally {
      setConnectingId(null);
    }
  }

  async function handleDoubleClick(server: Server) {
    const existing = sessions.find((s) => s.server_id === server.id);
    if (existing) { setActiveTab(existing.session_id); return; }
    await openSession(server);
  }

  function handleContextMenu(e: React.MouseEvent, server: Server) {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, server });
  }

  return (
    <>
      <div className="panel hosts-panel">
        <div className="panel-title-row">
          <div className="panel-title">Hosts</div>
          <button className="btn-primary btn-sm" onClick={() => { setEditServer(null); setShowServerForm(true); }}>
            + Add Host
          </button>
        </div>

        {connectError && (
          <div className="connect-error-banner">
            {connectError}
            <button onClick={() => setConnectError('')}>✕</button>
          </div>
        )}
        {servers.length === 0 ? (
          <div className="hosts-empty">
            <p>No hosts yet.</p>
            <button className="btn-primary" onClick={() => { setEditServer(null); setShowServerForm(true); }}>
              Add your first host
            </button>
          </div>
        ) : (
          <div className="hosts-grid">
            {servers.map((server) => {
              const connected = connectedIds.has(server.id);
              const isConnecting = connectingId === server.id;
              return (
                <div
                  key={server.id}
                  className="host-card"
                  onDoubleClick={() => handleDoubleClick(server)}
                  onContextMenu={(e) => handleContextMenu(e, server)}
                  title="Double-click to connect · Right-click for options"
                >
                  <div className="host-card-icon">
                    <OsIcon os={server.os ?? 'linux'} size={28} />
                  </div>
                  <div className="host-card-info">
                    <div className="host-card-name-row">
                      <span className={`dot ${connected ? 'dot-on' : 'dot-off'}`} />
                      <span className="host-card-name">{server.name}</span>
                    </div>
                    <span className="host-card-addr">{server.host}:{server.port}</span>
                    {isConnecting && <span className="host-status">Connecting…</span>}
                    {connected && !isConnecting && <span className="host-status host-status-on">Connected</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="host-context-menu"
          style={{
            top: Math.min(contextMenu.y, window.innerHeight - 120),
            left: Math.min(contextMenu.x, window.innerWidth - 160),
          }}
        >
          {(() => {
            const activeSessions = sessions.filter((s) => s.server_id === contextMenu.server.id);
            return (
              <>
                {activeSessions.length > 0 && (
                  <>
                    {activeSessions.map((s) => (
                      <button key={s.session_id} className="host-ctx-item host-ctx-danger" onClick={() => {
                        invoke('ssh_disconnect', { sessionId: s.session_id }).catch(() => {});
                        removeSession(s.session_id);
                        setContextMenu(null);
                      }}>
                        End {s.server_name}
                      </button>
                    ))}
                    <div className="host-ctx-divider" />
                  </>
                )}
                <button className="host-ctx-item" onClick={() => { setContextMenu(null); openSession(contextMenu.server); }}>
                  Duplicate
                </button>
                <button className="host-ctx-item" onClick={() => { setContextMenu(null); setEditServer(contextMenu.server); setShowServerForm(true); }}>
                  Edit
                </button>
                <div className="host-ctx-divider" />
                <button className="host-ctx-item host-ctx-danger" onClick={() => { setConfirmDeleteId(contextMenu.server.id); setContextMenu(null); }}>
                  Remove
                </button>
              </>
            );
          })()}
        </div>
      )}

      {showServerForm && (
        <ServerForm
          server={editServer}
          onClose={() => { setShowServerForm(false); setEditServer(null); }}
          onDelete={editServer ? () => setConfirmDeleteId(editServer.id) : undefined}
        />
      )}
      {connectServer && (
        <ConnectDialog
          server={connectServer}
          onClose={() => setConnectServer(null)}
        />
      )}
      {confirmDeleteId && (
        <>
          <div className="modal-overlay" onClick={() => setConfirmDeleteId(null)} />
          <div className="kc-confirm-modal">
            <p>Delete this host?</p>
            <div className="kc-confirm-actions">
              <button className="btn-secondary btn-sm" onClick={() => setConfirmDeleteId(null)}>Cancel</button>
              <button className="btn-danger btn-sm" onClick={() => { deleteServer(confirmDeleteId); setConfirmDeleteId(null); setShowServerForm(false); setEditServer(null); }}>Delete</button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
