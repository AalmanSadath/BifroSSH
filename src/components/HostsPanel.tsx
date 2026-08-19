import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store/appStore';
import type { Server } from '../types';
import ServerForm from './ServerForm';
import SshConfigImport from './SshConfigImport';
import OsIcon from './OsIcon';
import ConfirmModal from './shared/ConfirmModal';
import ContextMenu from './shared/ContextMenu';

export default function HostsPanel() {
  const { servers, sessions, settings, setActiveTab, removeSession, deleteServer, openSession } = useAppStore();
  const [showServerForm, setShowServerForm] = useState(false);
  const [showSshImport, setShowSshImport] = useState(false);
  const [editServer, setEditServer] = useState<Server | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ kind: 'server'; x: number; y: number; server: Server } | { kind: 'panel'; x: number; y: number } | null>(null);

  const connectedIds = new Set(sessions.map((s) => s.server_id));

  async function handleDoubleClick(server: Server) {
    const existing = sessions.find((s) => s.server_id === server.id && s.status === 'connected');
    if (existing) { setActiveTab(existing.session_id); return; }
    openSession(server.id);
  }

  function handleContextMenu(e: React.MouseEvent, server: Server) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ kind: 'server', x: e.clientX, y: e.clientY, server });
  }

  return (
    <>
      <div className="panel hosts-panel" onContextMenu={(e) => { if ((e.target as HTMLElement).closest('button, input, textarea, select, label, a')) return; e.preventDefault(); setContextMenu({ kind: 'panel', x: e.clientX, y: e.clientY }); }}>
        <div className="panel-title-row">
          <div className="panel-title">Hosts</div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          <button className="btn-primary btn-sm" onClick={() => { setEditServer(null); setShowServerForm(true); }}>
            + Add Host
          </button>
          <button className="btn-secondary btn-sm" onClick={() => setShowSshImport(true)}>
            Import from ssh config
          </button>
        </div>

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
              const isConnecting = sessions.some((s) => s.server_id === server.id && s.status === 'connecting');
              return (
                <div
                  key={server.id}
                  className="host-card"
                  onDoubleClick={() => handleDoubleClick(server)}
                  onContextMenu={(e) => handleContextMenu(e, server)}
                  title={settings.show_hover_hints ? 'Double-click to connect · Right-click for options' : undefined}
                >
                  <div className="host-card-icon">
                    <OsIcon os={server.os ?? 'linux'} size={28} />
                  </div>
                  <div className="host-card-info">
                    <div className="host-card-name-row">
                      {/* The dot is the whole status. Spelling it out underneath
                          gave the connected card a third line and made it taller
                          than the others in its row. */}
                      <span
                        className={`dot ${isConnecting ? 'dot-connecting' : connected ? 'dot-on' : 'dot-off'}`}
                        title={isConnecting ? 'Connecting…' : connected ? 'Connected' : 'Not connected'}
                      />
                      <span className="host-card-name">{server.name}</span>
                    </div>
                    <span className="host-card-addr">{server.host}:{server.port}</span>
                  </div>
                  <button
                    className="host-card-edit-btn"
                    onClick={(e) => { e.stopPropagation(); setEditServer(server); setShowServerForm(true); }}
                    title={settings.show_hover_hints ? 'Edit host' : undefined}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
                      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
                    </svg>
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {contextMenu && (
        <ContextMenu x={contextMenu.x} y={contextMenu.y} onClose={() => setContextMenu(null)}>
          {contextMenu.kind === 'panel' ? (
            <button className="menu-item" onClick={() => { setContextMenu(null); setEditServer(null); setShowServerForm(true); }}>
              Add Host
            </button>
          ) : (
            (() => {
              const activeSessions = sessions.filter((s) => s.server_id === contextMenu.server.id);
              return (
                <>
                  {activeSessions.length > 0 && (
                    <>
                      {activeSessions.map((s) => (
                        <button key={s.session_id} className="menu-item menu-item-danger" onClick={() => {
                          if (s.status === 'connected') invoke('ssh_disconnect', { sessionId: s.session_id }).catch(() => {});
                          removeSession(s.session_id);
                          setContextMenu(null);
                        }}>
                          End {s.server_name}
                        </button>
                      ))}
                      <div className="menu-divider" />
                    </>
                  )}
                  {/* Same action either way, but the word has to match what
                      it does: with nothing open there is nothing to duplicate,
                      and "Duplicate" read as though it would copy the host. */}
                  <button className="menu-item" onClick={() => { setContextMenu(null); openSession(contextMenu.server.id); }}>
                    {activeSessions.length > 0 ? 'Duplicate' : 'Connect'}
                  </button>
                  <button className="menu-item" onClick={() => { setContextMenu(null); setEditServer(contextMenu.server); setShowServerForm(true); }}>
                    Edit
                  </button>
                  <div className="menu-divider" />
                  <button className="menu-item menu-item-danger" onClick={() => { setConfirmDeleteId(contextMenu.server.id); setContextMenu(null); }}>
                    Remove
                  </button>
                </>
              );
            })()
          )}
        </ContextMenu>
      )}

      {showSshImport && <SshConfigImport onClose={() => setShowSshImport(false)} />}

      {showServerForm && (
        <ServerForm
          server={editServer}
          onClose={() => { setShowServerForm(false); setEditServer(null); }}
          onDelete={editServer ? () => setConfirmDeleteId(editServer.id) : undefined}
        />
      )}
      {confirmDeleteId && (
        <ConfirmModal
          question="Delete this host?"
          onCancel={() => setConfirmDeleteId(null)}
          onConfirm={() => { deleteServer(confirmDeleteId); setConfirmDeleteId(null); setShowServerForm(false); setEditServer(null); }}
        />
      )}
    </>
  );
}
