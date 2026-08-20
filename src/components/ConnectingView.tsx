import { useState, useEffect } from 'react';
import type { LogEntry, Server } from '../types';
import OsIcon from './OsIcon';
import ConnectLog, { formatLogs } from './ConnectLog';

interface Props {
  server: Server;
  /** Connection transcript so far. */
  logs: LogEntry[];
  error?: string;
  /** Dismisses this screen. Terminal sessions close the tab; SFTP goes back to
   *  the host picker. */
  onClose: () => void;
  onRetry?: () => void;
  onEditHost?: () => void;
  /** Wording for the primary retry action. */
  retryLabel?: string;
}

export default function ConnectingView({
  server, logs, error, onClose, onRetry, onEditHost, retryLabel = 'Start over',
}: Props) {

  const [showLogs, setShowLogs] = useState(false);

  const isError = !!error;

  useEffect(() => {
    if (isError) setShowLogs(true);
  }, [isError]);

  function copyLogs() {
    navigator.clipboard.writeText(formatLogs(logs)).catch(() => {});
  }

  return (
    <div className="connecting-page">
      <div className="connecting-card">
        <div className="connecting-header">
          <div className="connecting-os-icon">
            <OsIcon os={server.os} size={40} />
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
          <ConnectLog
            logs={logs}
            emptyText={isError ? undefined : 'Waiting for connection events…'}
          />
        )}

        <div className="connecting-actions">
          <button className="btn-secondary btn-sm" onClick={onClose}>Close</button>
          {isError && onEditHost && (
            <button className="btn-secondary btn-sm" onClick={onEditHost}>Edit host</button>
          )}
          {isError && onRetry && (
            <button className="btn-primary btn-sm connecting-retry-btn" onClick={onRetry}>
              {retryLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
