import { useEffect, useRef, useState } from 'react';
import * as ipc from '../ipc';
import {
  NOT_LINUX, diskPercent, level, memPercent, rates, type Rates,
} from '../hostStats';
import { formatSize, formatSpeed } from '../transferStatus';
import type { HostSample } from '../types';

/** How often a reading is taken while the tab is on screen. */
const EVERY_MS = 3_000;

interface Props {
  /** The live session to read through, or null while there is none. */
  sessionId: string | null;
  /** On screen. A hidden tab is not read at all. */
  visible: boolean;
}

type Status = 'reading' | 'ok' | 'failed' | 'unsupported';

/**
 * The strip under a terminal with the host's CPU, memory, disk, network and
 * load.
 *
 * Always the same height, whatever it is showing, so the terminal above it is
 * sized once when the bar appears and never again between readings.
 */
export default function MonitorBar({ sessionId, visible }: Props) {
  const [sample, setSample] = useState<HostSample | null>(null);
  const [rate, setRate] = useState<Rates>({ cpuPercent: null, rxPerSec: null, txPerSec: null });
  const [status, setStatus] = useState<Status>('reading');
  const lastRef = useRef<{ sample: HostSample; at: number } | null>(null);
  /** Sessions that answered "not Linux", so they are not asked again. */
  const unsupportedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!sessionId || !visible || unsupportedRef.current.has(sessionId)) return;
    let stopped = false;
    let inFlight = false;

    const read = () => {
      // A slow host is left to finish rather than asked twice at once.
      if (inFlight || stopped) return;
      inFlight = true;
      ipc.sshHostStats(sessionId)
        .then((cur) => {
          if (stopped) return;
          const now = performance.now();
          const last = lastRef.current;
          setRate(rates(last?.sample ?? null, cur, last ? (now - last.at) / 1000 : 0));
          lastRef.current = { sample: cur, at: now };
          setSample(cur);
          setStatus('ok');
        })
        .catch((e) => {
          if (stopped) return;
          if (String(e).includes(NOT_LINUX)) {
            unsupportedRef.current.add(sessionId);
            setStatus('unsupported');
            clearInterval(timer);
          } else {
            setStatus('failed');
          }
        })
        .finally(() => {
          inFlight = false;
        });
    };

    read();
    const timer = setInterval(read, EVERY_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [sessionId, visible]);

  // A new session is a fresh start: its counters mean nothing next to the
  // last one's, which may be a different boot of the machine altogether.
  useEffect(() => {
    lastRef.current = null;
    setRate({ cpuPercent: null, rxPerSec: null, txPerSec: null });
    if (sessionId && !unsupportedRef.current.has(sessionId)) setStatus('reading');
  }, [sessionId]);

  if (status === 'unsupported') {
    return <div className="term-monitor term-monitor-note">No monitor for this host: it has no Linux /proc to read.</div>;
  }

  const mem = sample ? memPercent(sample) : null;
  const disk = sample ? diskPercent(sample) : null;
  const stale = !sessionId || status === 'failed';

  return (
    <div className={`term-monitor${stale ? ' term-monitor-stale' : ''}`}>
      <Meter label="CPU" percent={rate.cpuPercent} />
      <Meter
        label="Mem"
        percent={mem}
        detail={sample ? `${formatSize(sample.mem_total - sample.mem_available)} / ${formatSize(sample.mem_total)}` : undefined}
      />
      <Meter label="Disk /" percent={disk} />
      <span className="term-monitor-item">
        ↓ {rate.rxPerSec === null ? '–' : formatSpeed(rate.rxPerSec)}
        {'  '}↑ {rate.txPerSec === null ? '–' : formatSpeed(rate.txPerSec)}
      </span>
      <span className="term-monitor-item">
        Load {sample?.load1 != null ? sample.load1.toFixed(2) : '–'}
      </span>
      {status === 'failed' && sessionId && <span className="term-monitor-item term-monitor-warn">No reading</span>}
    </div>
  );
}

function Meter({ label, percent, detail }: { label: string; percent: number | null; detail?: string }) {
  const lv = level(percent);
  return (
    <span className="term-monitor-item" title={detail}>
      {label}{' '}
      <span className="term-meter">
        <span className={`term-meter-fill term-meter-${lv}`} style={{ width: `${Math.min(100, percent ?? 0)}%` }} />
      </span>{' '}
      <span className={`term-monitor-value term-monitor-${lv}`}>
        {percent === null ? '–' : `${Math.round(percent)}%`}
      </span>
      {detail && <span className="term-monitor-detail"> {detail}</span>}
    </span>
  );
}
