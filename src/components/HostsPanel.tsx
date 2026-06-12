import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store/appStore';
import type { Server } from '../types';
import ServerForm from './ServerForm';
import ConnectDialog from './ConnectDialog';
import OsIcon from './OsIcon';

export default function HostsPanel() {
  const { servers, sessions, setActiveTab, deleteServer, identities, addSession, detectServerOs } = useAppStore();
  const [showServerForm, setShowServerForm] = useState(false);
  const [editServer, setEditServer] = useState<Server | null>(null);
  const [connectServer, setConnectServer] = useState<Server | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const connectedIds = new Set(sessions.map((s) => s.server_id));

  function openEdit(server: Server, e: React.MouseEvent) {
    e.stopPropagation();
    setEditServer(server);
    setShowServerForm(true);
  }

  async function handleDoubleClick(server: Server) {
    const sess = sessions.find((s) => s.server_id === server.id);
    if (sess) { setActiveTab(sess.session_id); return; }

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
      addSession({ session_id: sessionId, server_name: server.name, server_id: server.id });
      if (server.os === '') detectServerOs(server.id, identity.username, 'key', identity.key_id);
    } catch (err) {
      setConnectError(String(err));
    } finally {
      setConnectingId(null);
    }
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
                  title="Double-click to connect"
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
                  <button
                    className="kc-card-edit-btn"
                    onClick={(e) => { e.stopPropagation(); openEdit(server, e); }}
                    title="Edit"
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

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
