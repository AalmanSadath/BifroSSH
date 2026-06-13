import { useState, useEffect, useRef } from 'react';
import { useAppStore } from '../store/appStore';
import type { Server } from '../types';
import OsIcon from './OsIcon';

interface Props {
  tabId: string;
  server: Server;
  error?: string;
  onRetry?: () => void;
  onEditHost?: () => void;
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
    if (kind === 'error') return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
    );
    if (kind === 'auth') return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>
      </svg>
    );
    return (
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/>
      </svg>
    );
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
          {isError && onEditHost && (
            <button className="btn-secondary btn-sm" onClick={onEditHost}>Edit host</button>
          )}
          {isError && onRetry && (
            <button className="btn-primary btn-sm connecting-retry-btn" onClick={() => { removeSession(tabId); onRetry(); }}>
              Start over
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
