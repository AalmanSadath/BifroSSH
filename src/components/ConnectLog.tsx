import { useEffect, useRef } from 'react';
import type { LogEntry } from '../types';

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

export function formatLogs(logs: LogEntry[]): string {
  return logs.map((e) => `[${e.kind}] ${e.message}`).join('\n');
}

interface Props {
  logs: LogEntry[];
  /** Shown when there are no entries yet. */
  emptyText?: string;
  /** Follows new entries. Off once a connection has settled. */
  autoScroll?: boolean;
}

/** The connection transcript, shared by the connecting view and the session log. */
export default function ConnectLog({ logs, emptyText, autoScroll = true }: Props) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll) endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs.length, autoScroll]);

  return (
    <div className="connecting-logs">
      {logs.map((entry, i) => (
        <div
          key={i}
          className={`connecting-log-line${entry.kind === 'error' ? ' connecting-log-line-error' : ''}`}
        >
          <span className="connecting-log-bullet">{logIcon(entry.kind)}</span>
          {entry.message}
        </div>
      ))}
      {logs.length === 0 && emptyText && (
        <div className="connecting-log-line connecting-log-dim">{emptyText}</div>
      )}
      <div ref={endRef} />
    </div>
  );
}
