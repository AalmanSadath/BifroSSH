import { resumable, type QueueItem } from '../../transferQueue';
import { statusLine } from '../../transferStatus';
import { useHint } from '../shared/useHint';

/** One transfer in the queue: its name, where it is going, how it is doing. */
function QueueRow({ row, onCancel, onResume }: { row: QueueItem; onCancel: () => void; onResume: () => void }) {
  const hint = useHint();
  const p = row.progress;
  const { text: status, pct } = statusLine(row, Date.now());
  const running = row.status === 'running';
  return (
    <div className={`sftp-queue-row sftp-queue-${row.status}`}>
      <div className="sftp-queue-info">
        <span className="sftp-queue-name" title={row.name}>
          {row.name}
          <span className="sftp-queue-dest"> → {row.destination}</span>
        </span>
        <span className="sftp-queue-stat" title={row.status === 'failed' ? row.error ?? undefined : undefined}>
          {running && p ? p.file_name !== row.name ? `${p.file_name} · ${status}` : status : status}
        </span>
        {resumable(row) && (
          <button
            type="button"
            className="sftp-resume-btn"
            onClick={onResume}
            title={hint('Continue from where it stopped')}
          >
            Resume
          </button>
        )}
        <button
          type="button"
          className="sftp-cancel-btn"
          onClick={onCancel}
          disabled={row.cancelling}
          title={row.status === 'queued' ? 'Remove' : running ? 'Stop' : 'Dismiss'}
        >
          ✕
        </button>
      </div>
      {running && (
        <div className="sftp-progress-track">
          <div className="sftp-progress-fill" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

interface TransferQueueProps {
  queue: QueueItem[];
  onCancel: (id: string) => void;
  onResume: (id: string) => void;
  onClearFinished: () => void;
}

/** The strip under the panes listing every transfer, running, waiting or done. */
export default function TransferQueue({ queue, onCancel, onResume, onClearFinished }: TransferQueueProps) {
  const toGo = queue.filter((q) => q.status === 'queued' || q.status === 'running').length;
  return (
    <div className="sftp-queue">
      <div className="sftp-queue-head">
        <span>{toGo > 0 ? `${toGo} to go` : 'Transfers'}</span>
        {queue.some((q) => q.status !== 'queued' && q.status !== 'running') && (
          <button type="button" className="sftp-queue-clear" onClick={onClearFinished}>
            Clear finished
          </button>
        )}
      </div>
      {queue.map((row) => (
        <QueueRow
          key={row.id}
          row={row}
          onCancel={() => onCancel(row.id)}
          onResume={() => onResume(row.id)}
        />
      ))}
    </div>
  );
}
