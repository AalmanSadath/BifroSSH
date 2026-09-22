import { useEffect, useState } from 'react';
import * as ipc from '../../ipc';
import { useAppStore, reportFailure } from '../../store/appStore';
import NumberSetting from '../shared/NumberSetting';
import { usePatch } from './Picker';

/** Timeouts, what comes back on its own, and where a session's log goes. */
export default function ConnectionSection() {
  const { settings } = useAppStore();
  const patch = usePatch();
  // The folder in use, asked from the backend so a default path is shown
  // rather than an empty box.
  const [logDir, setLogDir] = useState<string | null>(null);
  const [logDirDraft, setLogDirDraft] = useState(settings.session_log_dir ?? '');
  useEffect(() => { ipc.sessionLogDir().then(setLogDir).catch(() => {}); }, [settings.session_log_dir]);
  useEffect(() => { setLogDirDraft(settings.session_log_dir ?? ''); }, [settings.session_log_dir]);

  return (
    <>
      <section className="panel-section">
        <h3>Timeouts</h3>
        <NumberSetting
          label="Global timeout (seconds)"
          value={settings.connection_timeout_secs}
          min={1}
          max={3600}
          onCommit={(v) => patch({ connection_timeout_secs: v })}
        />
        <p className="form-hint">Connection attempt timeout. Per-host timeout can be set in host settings and overrides this value.</p>
        <NumberSetting
          label="SFTP inactivity timeout (seconds)"
          value={settings.sftp_inactivity_timeout_secs}
          min={30}
          max={86400}
          onCommit={(v) => patch({ sftp_inactivity_timeout_secs: v })}
        />
        <p className="form-hint">How long an idle SFTP session is kept alive.</p>
        <NumberSetting
          label="Keepalive interval (seconds)"
          value={settings.keepalive_interval_secs}
          min={0}
          max={3600}
          onCommit={(v) => patch({ keepalive_interval_secs: v })}
        />
        <p className="form-hint">
          Sends a periodic keepalive on terminal sessions and tunnels so they are not dropped by
          a NAT or firewall idle timer, and so a dead connection is noticed rather than hanging.
          A connection is considered lost after three unanswered keepalives. Set to 0 to disable.
          Does not apply to SFTP, which uses the inactivity timeout above instead.
        </p>
      </section>

      <section className="panel-section">
        <h3>Sessions</h3>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.restore_tabs}
            onChange={(e) => patch({ restore_tabs: e.target.checked })}
          />
          <span>Reopen tabs from last time</span>
        </label>
        <p className="form-hint">
          The hosts that had a tab open when the app last closed are opened again and connected,
          one after another. Quick connections are not: nothing about them was saved.
        </p>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.auto_reconnect}
            onChange={(e) => patch({ auto_reconnect: e.target.checked })}
          />
          <span>Reconnect a dropped session automatically</span>
        </label>
        <p className="form-hint">
          A session whose connection dies is opened again five seconds later, then at twice the
          wait each time up to a minute. The tab and its scrollback stay where they are, and the
          banner counts down with a button to stop or to try at once. A session you close, or one
          whose shell exited, is never reopened.
        </p>
        {settings.auto_reconnect && (
          <>
            <NumberSetting
              label="Attempts before giving up"
              value={settings.auto_reconnect_attempts}
              min={0}
              max={100}
              onCommit={(v) => patch({ auto_reconnect_attempts: v })}
            />
            <p className="form-hint">0 keeps trying until it comes back or you stop it.</p>
          </>
        )}
        <div className="form-group">
          <label>Session logs folder</label>
          <div className="settings-inline-row">
            <input
              type="text"
              value={logDirDraft}
              placeholder={logDir ?? 'Default'}
              onChange={(e) => setLogDirDraft(e.target.value)}
              onBlur={() => patch({ session_log_dir: logDirDraft.trim() || null })}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            />
            <button className="btn-secondary btn-sm" onClick={() => { if (logDir) ipc.sftpOpenLocal(logDir).catch(reportFailure); }}>
              Open folder
            </button>
          </div>
        </div>
        <p className="form-hint">
          Where a session's output goes when a tab is logged, or a host is set to log every
          session. Empty means the app's own data folder.
        </p>
      </section>
    </>
  );
}
