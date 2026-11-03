import { useEffect, useState } from 'react';
import * as ipc from '../../ipc';
import { useAppStore, reportFailure } from '../../store/appStore';
import NumberSetting from '../shared/NumberSetting';
import { usePatch } from './Picker';
import { isAndroid } from '../../platform';

/** Timeouts, what comes back on its own, and where a session's log goes. */
export default function ConnectionSection() {
  const { settings } = useAppStore();
  const patch = usePatch();
  // The folder in use, asked from the backend so a default path is shown
  // rather than an empty box.
  const [logDir, setLogDir] = useState<string | null>(null);
  const [logDirDraft, setLogDirDraft] = useState(settings.session_log_dir ?? '');
  const [recDir, setRecDir] = useState<string | null>(null);
  const [recDirDraft, setRecDirDraft] = useState(settings.recording_dir ?? '');
  useEffect(() => { ipc.recordingDir().then(setRecDir).catch(() => {}); }, [settings.recording_dir]);
  useEffect(() => { setRecDirDraft(settings.recording_dir ?? ''); }, [settings.recording_dir]);
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
        <p className="form-hint">A host can override this.</p>
        <NumberSetting
          label="SFTP inactivity timeout (seconds)"
          value={settings.sftp_inactivity_timeout_secs}
          min={30}
          max={86400}
          onCommit={(v) => patch({ sftp_inactivity_timeout_secs: v })}
        />
        <NumberSetting
          label="Keepalive interval (seconds)"
          value={settings.keepalive_interval_secs}
          min={0}
          max={3600}
          onCommit={(v) => patch({ keepalive_interval_secs: v })}
        />
        <p className="form-hint">Keeps NAT and firewalls from dropping idle sessions. 0 is off.</p>
      </section>

      <section className="panel-section">
        <h3>Sessions</h3>
        {isAndroid && (
          <>
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={settings.keep_awake}
                onChange={(e) => patch({ keep_awake: e.target.checked })}
              />
              <span>Keep connections alive with the screen off</span>
            </label>
            <p className="form-hint">Keeps the phone awake while connected; uses more battery.</p>
          </>
        )}
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.restore_tabs}
            onChange={(e) => patch({ restore_tabs: e.target.checked })}
          />
          <span>Reopen tabs from last time</span>
        </label>
        <p className="form-hint">Reconnects the hosts that were open when the app closed.</p>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.auto_reconnect}
            onChange={(e) => patch({ auto_reconnect: e.target.checked })}
          />
          <span>Reconnect a dropped session automatically</span>
        </label>
        <p className="form-hint">Retries after 5s, doubling up to a minute.</p>
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
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={settings.verify_transfers}
            onChange={(e) => patch({ verify_transfers: e.target.checked })}
          />
          <span>Verify transfers with a checksum</span>
        </label>
        <p className="form-hint">Compares both sides with SHA-256 after a transfer. Slow.</p>

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
            {!isAndroid && <button className="btn-secondary btn-sm" onClick={() => { if (logDir) ipc.sftpOpenLocal(logDir).catch(reportFailure); }}>
              Open folder
            </button>}
          </div>
        </div>
        <p className="form-hint">Empty uses the app data folder.</p>

        <div className="form-group">
          <label>Recordings folder</label>
          <div className="settings-inline-row">
            <input
              type="text"
              value={recDirDraft}
              placeholder={recDir ?? 'Default'}
              onChange={(e) => setRecDirDraft(e.target.value)}
              onBlur={() => patch({ recording_dir: recDirDraft.trim() || null })}
              onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
            />
            {!isAndroid && <button className="btn-secondary btn-sm" onClick={() => { if (recDir) ipc.sftpOpenLocal(recDir).catch(reportFailure); }}>
              Open folder
            </button>}
          </div>
        </div>
        <p className="form-hint">Empty uses the app data folder.</p>
      </section>
    </>
  );
}
