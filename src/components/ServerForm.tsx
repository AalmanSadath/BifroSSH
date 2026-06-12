import { useState } from 'react';
import { useAppStore } from '../store/appStore';
import ThemePicker from './ThemePicker';
import { THEMES } from '../styles/themes';
import type { Server } from '../types';

interface Props {
  server: Server | null;
  onClose: () => void;
}

export default function ServerForm({ server, onClose }: Props) {
  const { identities, saveServer } = useAppStore();
  const [name, setName] = useState(server?.name ?? '');
  const [host, setHost] = useState(server?.host ?? '');
  const [port, setPort] = useState(server?.port ?? 22);
  const [identityId, setIdentityId] = useState(server?.identity_id ?? '');
  const [themeOverride, setThemeOverride] = useState<string | null>(server?.theme ?? null);
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
      await saveServer({
        id: server?.id,
        name: name.trim(),
        host: host.trim(),
        port,
        identity_id: identityId || null,
        theme: themeOverride,
      });
      onClose();
    } catch (err) {
      setError(String(err));
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{server ? 'Edit Server' : 'Add Server'}</h2>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit}>
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
            <button
              type="button"
              className="collapsible-header"
              onClick={() => setThemeExpanded((v) => !v)}
            >
              <span className="collapsible-title">Terminal Theme</span>
              <span className="collapsible-meta">
                {themeOverride === null ? 'Global default' : (THEMES[themeOverride]?.name ?? themeOverride)}
              </span>
              <span className={`collapsible-arrow${themeExpanded ? ' open' : ''}`}>▶</span>
            </button>
            {themeExpanded && (
              <div className="collapsible-body">
                <label className="checkbox-row" style={{ marginBottom: 10 }}>
                  <input
                    type="checkbox"
                    checked={themeOverride === null}
                    onChange={(e) => setThemeOverride(e.target.checked ? null : 'bifrossh-dark')}
                  />
                  <span>Use global setting</span>
                </label>
                {themeOverride !== null && (
                  <ThemePicker value={themeOverride} onChange={setThemeOverride} />
                )}
              </div>
            )}
          </div>
          {error && <p className="form-error">{error}</p>}
          <div className="modal-actions">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
