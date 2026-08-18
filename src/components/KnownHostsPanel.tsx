import { useCallback, useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useAppStore } from '../store/appStore';
import type { HostKeyPolicy, KnownHostEntry } from '../types';
import ConfirmModal from './shared/ConfirmModal';

const POLICIES: { value: HostKeyPolicy; label: string; hint: string }[] = [
  { value: 'ask', label: 'Ask', hint: 'Prompts you to confirm a server the first time you connect to it.' },
  { value: 'accept-new', label: 'Accept new', hint: 'Trusts a server the first time you connect, without asking.' },
  { value: 'strict', label: 'Strict', hint: 'Refuses any server that is not already listed below.' },
];

function label(entry: KnownHostEntry) {
  return entry.port === 22 ? entry.host : `${entry.host}:${entry.port}`;
}

export default function KnownHostsPanel() {
  const { settings, saveSettings } = useAppStore();
  const [hosts, setHosts] = useState<KnownHostEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [confirmForget, setConfirmForget] = useState<KnownHostEntry | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setHosts(await invoke<KnownHostEntry[]>('list_known_hosts'));
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = q
      ? hosts.filter(
          (h) =>
            h.host.toLowerCase().includes(q) ||
            h.fingerprint.toLowerCase().includes(q) ||
            h.key_type.toLowerCase().includes(q),
        )
      : hosts;
    // Our own entries first, then OpenSSH's, each alphabetical.
    return [...matches].sort((a, b) => {
      if (a.source !== b.source) return a.source === 'bifrossh' ? -1 : 1;
      return label(a).localeCompare(label(b));
    });
  }, [hosts, query]);

  const ownCount = hosts.filter((h) => h.source === 'bifrossh').length;
  const opensshCount = hosts.length - ownCount;

  async function forget(entry: KnownHostEntry) {
    try {
      await invoke('forget_known_host', { host: entry.host, port: entry.port });
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setConfirmForget(null);
    }
  }

  async function copyFingerprint(entry: KnownHostEntry) {
    try {
      await navigator.clipboard.writeText(entry.fingerprint);
      setCopied(entry.fingerprint);
      setTimeout(() => setCopied(null), 1200);
    } catch {
      /* clipboard unavailable — not worth interrupting the user */
    }
  }

  return (
    <div className="panel">
      <div className="panel-title">Known Hosts</div>

      <section className="panel-section">
        <h3>When connecting to a new server</h3>
        <div className="toggle-row">
          {POLICIES.map((p) => (
            <button
              key={p.value}
              type="button"
              className={`toggle-btn${settings.host_key_policy === p.value ? ' active' : ''}`}
              onClick={() => saveSettings({ ...settings, host_key_policy: p.value })}
            >
              {p.label}
            </button>
          ))}
        </div>
        <p className="form-hint">
          {POLICIES.find((p) => p.value === settings.host_key_policy)?.hint}{' '}
          A server whose key does not match the one stored here is always refused, whichever
          option is selected.
        </p>
      </section>

      <section className="panel-section">
        <div className="panel-section-header">
          <h3>
            Stored keys
            {hosts.length > 0 && (
              <span className="kh-count">
                {ownCount} in BifroSSH
                {opensshCount > 0 && ` · ${opensshCount} from ~/.ssh`}
              </span>
            )}
          </h3>
        </div>

        {hosts.length > 0 && (
          <input
            className="kh-search"
            type="text"
            placeholder="Filter by host, type or fingerprint"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
          />
        )}

        {error && <p className="form-hint kh-error">{error}</p>}

        {loading ? (
          <p className="form-hint">Loading…</p>
        ) : hosts.length === 0 ? (
          <div className="kh-empty">
            <p>No host keys stored yet.</p>
            <p className="form-hint">
              The first time you connect to a server, you&apos;ll be asked to confirm its
              fingerprint. Once you trust it, it appears here.
            </p>
          </div>
        ) : filtered.length === 0 ? (
          <p className="form-hint">No hosts match “{query}”.</p>
        ) : (
          <div className="kh-list">
            {filtered.map((h) => (
              <div className="kh-row" key={`${h.source}-${h.line}`}>
                <div className="kh-main">
                  <div className="kh-host">
                    <span className="kh-name">{label(h)}</span>
                    <span className={`kh-tag kh-tag-${h.source}`}>
                      {h.source === 'bifrossh' ? 'BifroSSH' : '~/.ssh'}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="hostkey-fp kh-fp"
                    title="Copy fingerprint"
                    onClick={() => copyFingerprint(h)}
                  >
                    {copied === h.fingerprint ? 'Copied' : h.fingerprint}
                  </button>
                </div>
                <span className="kh-type">{h.key_type}</span>
                {h.source === 'bifrossh' ? (
                  <button
                    type="button"
                    className="btn-danger btn-sm"
                    onClick={() => setConfirmForget(h)}
                  >
                    Forget
                  </button>
                ) : (
                  // ~/.ssh/known_hosts belongs to OpenSSH and is mounted
                  // read-only under Flatpak — never written by this app.
                  <span className="kh-readonly" title="Managed by OpenSSH, not editable here">
                    read-only
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      {confirmForget && (
        <ConfirmModal
          question={<>Forget the stored key for <strong>{label(confirmForget)}</strong>?</>}
          hint="You'll be asked to confirm this server's fingerprint again the next time you connect."
          confirmLabel="Forget"
          onCancel={() => setConfirmForget(null)}
          onConfirm={() => forget(confirmForget)}
        />
      )}
    </div>
  );
}
