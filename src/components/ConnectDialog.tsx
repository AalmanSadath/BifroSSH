import { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useAppStore } from '../store/appStore';
import type { LogEntry, Server } from '../types';

interface Props {
  server: Server;
  onClose: () => void;
}

export default function ConnectDialog({ server, onClose }: Props) {
  const { identities, keys, sessions, addSession, appendSessionLog, updateSessionConnected, updateSessionError, detectServerOs } = useAppStore();
  const identity = identities.find((i) => i.id === server.identity_id);

  const [username, setUsername] = useState(identity?.username ?? '');
  const [authType, setAuthType] = useState<'password' | 'key'>(identity ? 'key' : 'password');
  const [password, setPassword] = useState('');
  const [keyId, setKeyId] = useState(identity?.key_id ?? '');
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState('');

  async function handleConnect(e: React.FormEvent) {
    e.preventDefault();
    if (!username.trim()) { setError('Username required'); return; }
    if (authType === 'key' && !keyId) { setError('Select a key'); return; }

    const connectId = crypto.randomUUID();
    const existing = sessions.filter((s) => s.server_id === server.id).length;
    const tabName = existing === 0 ? server.name : `${server.name} (${existing})`;

    setConnecting(true);
    setError('');
    onClose();

    const unlisten = await listen<LogEntry>(`ssh-connect-log:${connectId}`, (event) => {
      appendSessionLog(connectId, event.payload);
    });

    addSession({
      session_id: connectId,
      server_name: tabName,
      server_id: server.id,
      status: 'connecting',
      connect_id: connectId,
      logs: [],
    });

    try {
      const sessionId = await invoke<string>('ssh_connect', {
        request: {
          server_id: server.id,
          username: username.trim(),
          auth_type: authType,
          auth_value: authType === 'password' ? password : keyId,
          cols: 80,
          rows: 24,
          connect_id: connectId,
        },
      });
      unlisten();
      updateSessionConnected(connectId, sessionId);
      if (server.os === '') detectServerOs(server.id, username.trim(), authType, authType === 'password' ? password : keyId);
    } catch (err) {
      unlisten();
      updateSessionError(connectId, String(err));
    } finally {
      setConnecting(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2>Connect</h2>
            <p className="modal-subtitle">{server.name} · {server.host}:{server.port}</p>
          </div>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleConnect}>
          <div className="form-group">
            <label>Username</label>
            <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="ubuntu" autoFocus />
          </div>
          <div className="auth-toggle">
            <button type="button" className={authType === 'password' ? 'active' : ''} onClick={() => setAuthType('password')}>
              Password
            </button>
            <button type="button" className={authType === 'key' ? 'active' : ''} onClick={() => setAuthType('key')}>
              SSH Key
            </button>
          </div>
          {authType === 'password' ? (
            <div className="form-group">
              <label>Password</label>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
          ) : (
            <div className="form-group">
              <label>Key</label>
              <select value={keyId} onChange={(e) => setKeyId(e.target.value)}>
                <option value="">Select a key…</option>
                {keys.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
              </select>
            </div>
          )}
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose} disabled={connecting}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={connecting}>
              {connecting ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
