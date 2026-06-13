import { useState } from 'react';
import { useAppStore } from '../store/appStore';
import ThemePicker, { ThumbNail } from './ThemePicker';
import { THEMES } from '../styles/themes';
import type { Server } from '../types';


interface Props {
  server: Server | null;
  onClose: () => void;
  onDelete?: () => void;
}

export default function ServerForm({ server, onClose, onDelete }: Props) {
  const { identities, saveServer } = useAppStore();
  const [name, setName] = useState(server?.name ?? '');
  const [host, setHost] = useState(server?.host ?? '');
  const [port, setPort] = useState(server?.port ?? 22);
  const [identityId, setIdentityId] = useState(server?.identity_id ?? '');
  const [themeOverride, setThemeOverride] = useState<string>(server?.theme ?? 'bifrossh-dark');
  const [timeoutSecs, setTimeoutSecs] = useState<string>(server?.connection_timeout != null ? String(server.connection_timeout) : '');
  const [themeExpanded, setThemeExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !host.trim()) {
      setError('Name and host are required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const parsed = parseInt(timeoutSecs, 10);
      await saveServer({
        id: server?.id,
        name: name.trim(),
        host: host.trim(),
        port,
        identity_id: identityId || null,
        theme: themeOverride as string | null,
        connection_timeout: timeoutSecs.trim() === '' || isNaN(parsed) ? null : Math.max(1, parsed),
      });
      onClose();
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  }

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <div className="drawer">
        <div className="drawer-header">
          <button className="drawer-close" onClick={onClose}>✕</button>
          <span>{server ? 'Edit Host' : 'Add Host'}</span>
          <button type="submit" form="host-form" className="btn-primary btn-sm" disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
        <div className="drawer-body">
          <form id="host-form" className="inline-form" onSubmit={handleSubmit}>
            <div className="form-group">
              <label>Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Production Web" autoFocus />
            </div>
            <div className="form-row">
              <div className="form-group flex-1">
                <label>Host</label>
                <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.100" />
              </div>
              <div className="form-group port-group">
                <label>Port</label>
                <input type="number" value={port} min={1} max={65535} onChange={(e) => setPort(Number(e.target.value))} />
              </div>
            </div>
            <div className="form-group">
              <label>Identity</label>
              <select value={identityId} onChange={(e) => setIdentityId(e.target.value)}>
                <option value="">None — prompt on connect</option>
                {identities.map((i) => (
                  <option key={i.id} value={i.id}>{i.name} ({i.username})</option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label>Connection Timeout (seconds)</label>
              <input
                type="number"
                min={1}
                max={3600}
                className="no-spinner"
                value={timeoutSecs}
                onChange={(e) => setTimeoutSecs(e.target.value)}
                placeholder="Global default (60s)"
              />
            </div>
            <div className="form-group">
              <div className="theme-current-row">
                <div className="theme-current-thumb">
                  <ThumbNail id={themeOverride} />
                </div>
                <span className="theme-current-name">{THEMES[themeOverride]?.name ?? themeOverride}</span>
              </div>
              <button
                type="button"
                className="theme-show-more-btn"
                onClick={() => setThemeExpanded((v) => !v)}
              >
                {themeExpanded ? 'Show less ∧' : 'Show more ∨'}
              </button>
              {themeExpanded && (
                <ThemePicker
                  value={themeOverride}
                  onChange={(id) => { setThemeOverride(id); setThemeExpanded(false); }}
                />
              )}
            </div>
            {error && <p className="form-error">{error}</p>}
          </form>
        </div>
        {onDelete && (
          <div className="drawer-footer">
            <button className="btn-danger btn-sm" onClick={onDelete}>
              Delete Host
            </button>
          </div>
        )}
      </div>
    </>
  );
}
