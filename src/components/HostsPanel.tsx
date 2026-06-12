import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store/appStore';
import type { Server } from '../types';
import ServerForm from './ServerForm';
import ConnectDialog from './ConnectDialog';

export default function HostsPanel() {
  const { servers, sessions, setActiveTab, deleteServer, identities, addSession } = useAppStore();
  const [showServerForm, setShowServerForm] = useState(false);
  const [editServer, setEditServer] = useState<Server | null>(null);
  const [connectServer, setConnectServer] = useState<Server | null>(null);
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [connectError, setConnectError] = useState('');

  const connectedIds = new Set(sessions.map((s) => s.server_id));

  function openEdit(server: Server, e: React.MouseEvent) {
    e.stopPropagation();
    setEditServer(server);
    setShowServerForm(true);
  }

  async function handleConnectBtn(server: Server, e: React.MouseEvent) {
    e.stopPropagation();
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
              const sess = sessions.find((s) => s.server_id === server.id);
              const isConnecting = connectingId === server.id;
              return (
                <div key={server.id} className="host-card" onClick={() => setConnectServer(server)}>
                  <div className="host-card-header">
                    <div className="host-card-name-row">
                      <span className={`dot ${connected ? 'dot-on' : 'dot-off'}`} />
                      <span className="host-card-name">{server.name}</span>
                    </div>
                    <div className="host-card-actions" onClick={(e) => e.stopPropagation()}>
                      <button className="action-btn" onClick={(e) => openEdit(server, e)} title="Edit">&#10000;</button>
                      <button className="action-btn danger" onClick={(e) => { e.stopPropagation(); deleteServer(server.id); }} title="Delete">&#10005;</button>
                    </div>
                  </div>
                  <div className="host-card-addr">{server.host}:{server.port}</div>
                  <div className="host-card-footer">
                    <span className={`host-status ${connected ? 'host-status-on' : ''}`}>
                      {connected ? 'Connected' : 'Idle'}
                    </span>
                    <button
                      className="btn-primary btn-sm"
                      disabled={isConnecting}
                      onClick={(e) => handleConnectBtn(server, e)}
                    >
                      {isConnecting ? 'Connecting…' : sess ? 'Switch' : 'Connect'}
                    </button>
                  </div>
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
        />
      )}
      {connectServer && (
        <ConnectDialog
          server={connectServer}
          onClose={() => setConnectServer(null)}
        />
      )}
    </>
  );
}
