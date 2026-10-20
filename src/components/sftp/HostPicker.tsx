import { useState } from 'react';
import { useAppStore } from '../../store/appStore';
import { matchesHost } from '../../hosts';
import type { Server } from '../../types';
import OsIcon from '../OsIcon';
import { useHint } from '../shared/useHint';
import { isAndroid } from '../../platform';

/** An idle pane: browse this computer, or pick a host. */
export function ConnectPrompt({ onSelectHost, onGoLocal }: { onSelectHost: () => void; onGoLocal?: () => void }) {
  const hint = useHint();
  return (
    <div className="sftp-connect-prompt" onContextMenu={(e) => e.preventDefault()}>
      <div className="sftp-source-list">
        {onGoLocal && (
          <button className="sftp-source-item" onDoubleClick={onGoLocal} onClick={onGoLocal} title={hint('Open local filesystem')}>
            <div className="sftp-source-icon">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
                <polyline points="9,22 9,12 15,12 15,22" />
              </svg>
            </div>
            <div className="sftp-source-info">
              <div className="sftp-source-name">Local Files</div>
              <div className="sftp-source-sub">Browse this computer</div>
            </div>
          </button>
        )}
        <div className="sftp-source-sep" />
        <button className="sftp-source-item sftp-source-remote" onClick={onSelectHost}>
          <div className="sftp-source-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <line x1="8" y1="21" x2="16" y2="21" />
              <line x1="12" y1="17" x2="12" y2="21" />
            </svg>
          </div>
          <div className="sftp-source-info">
            <div className="sftp-source-name">Remote Host</div>
            <div className="sftp-source-sub">Connect via SFTP</div>
          </div>
        </button>
      </div>
    </div>
  );
}

interface HostPickerProps {
  servers: Server[];
  connectingId: string | null;
  activeServerId?: string | null;
  error: string;
  onConnect: (server: Server) => void;
  onBack: () => void;
  onGoLocal?: () => void;
}

/** The hosts a pane can connect to, with a filter over them. */
export default function HostPicker({ servers, connectingId, activeServerId, error, onConnect, onBack, onGoLocal }: HostPickerProps) {
  const { identities } = useAppStore();
  const hint = useHint();
  const [query, setQuery] = useState('');
  const shown = servers.filter((s) => matchesHost(s, query));
  return (
    <div className="sftp-host-picker" onContextMenu={(e) => e.preventDefault()}>
      <div className="sftp-picker-header">
        <button className="sftp-back-btn" onClick={onBack} title={hint('Back')}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <polyline points="15,18 9,12 15,6" />
          </svg>
        </button>
        <span className="sftp-picker-title">Select Host</span>
        {onGoLocal && (
          <button className="sftp-local-header-btn" onClick={onGoLocal}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z" />
              <polyline points="9,22 9,12 15,12 15,22" />
            </svg>
            Local
          </button>
        )}
      </div>
      {error && <div className="sftp-picker-error">{error}</div>}
      {servers.length > 0 && (
        <div className="sftp-picker-search">
          <input
            type="text"
            placeholder="Filter by name, host, user, group or notes"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            autoFocus
          />
        </div>
      )}
      <div className="sftp-picker-list">
        {servers.length === 0 ? (
          <div className="sftp-picker-empty">No hosts configured. Add one in Hosts.</div>
        ) : shown.length === 0 ? (
          <div className="sftp-picker-empty">No hosts match.</div>
        ) : shown.map((s) => (
          <div
            key={s.id}
            className={`sftp-picker-item${connectingId === s.id ? ' sftp-picker-connecting' : ''}${activeServerId === s.id ? ' sftp-picker-has-session' : ''}`}
            onClick={isAndroid ? () => !connectingId && onConnect(s) : undefined}
            onDoubleClick={() => !connectingId && onConnect(s)}
            title={hint(activeServerId === s.id ? 'Double-click to resume' : 'Double-click to connect via SFTP')}
          >
            <div className="sftp-picker-icon">
              <OsIcon os={s.os} size={28} />
            </div>
            <div className="sftp-picker-info">
              <div className="sftp-picker-name">{s.name}</div>
              <div className="sftp-picker-addr">{(s.username ?? identities.find(i => i.id === s.identity_id)?.username ?? 'ssh')} · {s.host}:{s.port}</div>
            </div>
            {activeServerId === s.id && !connectingId && (
              <span className="sftp-active-badge">● Active</span>
            )}
            {connectingId === s.id && (
              <span className="sftp-picker-status">Connecting…</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
