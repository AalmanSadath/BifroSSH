import { useState, useEffect, useRef } from 'react';
import { useAppStore } from '../store/appStore';
import type { Server } from '../types';
import OsIcon from './OsIcon';

interface Props {
  tabId: string;
  server: Server;
  error?: string;
  onRetry: () => void;
  onEditHost: () => void;
}

export default function ConnectingView({ tabId, server, error, onRetry, onEditHost }: Props) {
  const { removeSession, sessions } = useAppStore();
  const session = sessions.find((s) => s.session_id === tabId);
  const logs = session?.logs ?? [];

  const [showLogs, setShowLogs] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);

  const isError = !!error;

  useEffect(() => {
    if (isError) setShowLogs(true);
  }, [isError]);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs.length, showLogs]);

  function copyLogs() {
    const text = logs.map((e) => `[${e.kind}] ${e.message}`).join('\n');
    navigator.clipboard.writeText(text).catch(() => {});
  }

  function logIcon(kind: string) {
    if (kind === 'error') return '😨';
    if (kind === 'auth') return '👤';
    return '⚙';
  }

  return (
    <div className="connecting-page">
      <div className="connecting-card">
        <div className="connecting-header">
          <div className="connecting-os-icon">
            <OsIcon os={server.os || 'linux'} size={40} />
          </div>
          <div className="connecting-info">
            <div className="connecting-name">{server.name}</div>
            <div className="connecting-addr">SSH {server.host}:{server.port}</div>
          </div>
          {isError ? (
            <button className="btn-secondary btn-sm connecting-log-btn" onClick={copyLogs}>
              Copy logs
            </button>
          ) : (
            <button className="btn-secondary btn-sm connecting-log-btn" onClick={() => setShowLogs((v) => !v)}>
              {showLogs ? 'Hide logs' : 'Show logs'}
            </button>
          )}
        </div>

        <div className="connecting-track">
          <div className={`connecting-spinner${isError ? ' connecting-spinner-error' : ''}`} />
          <div className={`connecting-line${isError ? ' connecting-line-error' : ''}`} />
          <div className={`connecting-terminal-icon${isError ? ' connecting-terminal-error' : ''}`}>&gt;_</div>
        </div>

        {isError && (
          <div className="connecting-failed-label">Connection failed with connection log:</div>
        )}

        {showLogs && (
          <div className="connecting-logs">
            {logs.map((entry, i) => (
              <div key={i} className={`connecting-log-line${entry.kind === 'error' ? ' connecting-log-line-error' : ''}`}>
                <span className="connecting-log-bullet">{logIcon(entry.kind)}</span>
                {entry.message}
              </div>
            ))}
            {!isError && logs.length === 0 && (
              <div className="connecting-log-line connecting-log-dim">Waiting for connection events…</div>
            )}
            <div ref={logsEndRef} />
          </div>
        )}

        <div className="connecting-actions">
          <button className="btn-secondary btn-sm" onClick={() => removeSession(tabId)}>Close</button>
          {isError && (
            <button className="btn-secondary btn-sm" onClick={onEditHost}>Edit host</button>
          )}
          {isError && (
            <button className="btn-primary btn-sm connecting-retry-btn" onClick={() => { removeSession(tabId); onRetry(); }}>
              Start over
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
