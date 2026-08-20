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
  /** What the copy button last did, so it can say so. */
  const [copied, setCopied] = useState<'no' | 'yes' | 'failed'>('no');

  const isError = !!error;

  useEffect(() => {
    if (isError) setShowLogs(true);
  }, [isError]);

  // Back to "Copy logs" after a moment, so the button is ready to be used
  // again and does not sit there claiming a copy that happened a minute ago.
  useEffect(() => {
    if (copied === 'no') return;
    const id = setTimeout(() => setCopied('no'), 2000);
    return () => clearTimeout(id);
  }, [copied]);

  async function copyLogs() {
    try {
      await navigator.clipboard.writeText(formatLogs(logs));
      setCopied('yes');
    } catch {
      // Silence here was survivable while nothing confirmed a success either.
      // Now that the button says "Copied", a failure that says nothing reads
      // as the same thing, so it has to speak up.
      setCopied('failed');
    }
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
          {!isError && (
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
          {isError && (
            <div className="connecting-actions-end">
              <button className="btn-secondary btn-sm" onClick={copyLogs}>
                {copied === 'yes' ? 'Copied' : copied === 'failed' ? 'Copy failed' : 'Copy logs'}
              </button>
              {onRetry && (
                <button className="btn-primary btn-sm" onClick={onRetry}>{retryLabel}</button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
