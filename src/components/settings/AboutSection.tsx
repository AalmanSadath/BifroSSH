import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import * as ipc from '../../ipc';
import { RELEASES_URL } from '../../updates';
import { formatDiagnostics, type DiagFacts } from '../../diagnostics';
import { useAppStore, reportFailure } from '../../store/appStore';
import { useCopy } from '../shared/useCopy';
import { usePatch } from './Picker';

/** This build, and whether a newer one exists. */
export default function AboutSection() {
  const { settings, updateAvailable, checkForUpdates } = useAppStore();
  const patch = usePatch();
  const [version, setVersion] = useState('');
  useEffect(() => { getVersion().then(setVersion).catch(() => {}); }, []);
  // The result of a check asked for by hand, which the daily one never
  // reports since nobody was waiting on it.
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<'up-to-date' | 'failed' | null>(null);

  async function checkNow() {
    setChecking(true);
    setCheckResult(null);
    const ran = await checkForUpdates(true);
    setChecking(false);
    if (!ran) setCheckResult('failed');
    else if (!useAppStore.getState().updateAvailable) setCheckResult('up-to-date');
  }

  return (
    <section className="panel-section">
      <h3>About</h3>
      <p className="form-hint form-hint-flush">BifroSSH {version}</p>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={settings.check_for_updates}
          onChange={(e) => patch({ check_for_updates: e.target.checked })}
        />
        <span>Check for updates once a day</span>
      </label>
      <p className="form-hint">
        One anonymous request to GitHub for the latest release. Nothing is downloaded or installed.
      </p>
      <div className="settings-inline-row">
        <button className="btn-secondary btn-sm" onClick={checkNow} disabled={checking}>
          {checking ? 'Checking…' : 'Check now'}
        </button>
        {updateAvailable ? (
          <button className="btn-primary btn-sm" onClick={() => openUrl(updateAvailable.url).catch(reportFailure)}>
            v{updateAvailable.version} available
          </button>
        ) : checkResult === 'up-to-date' ? (
          <span className="form-hint form-hint-flush">Up to date</span>
        ) : checkResult === 'failed' ? (
          <span className="form-hint form-hint-flush">Could not reach GitHub</span>
        ) : null}
      </div>
      <p className="form-hint">
        {settings.last_update_check > 0
          ? `Last checked ${new Date(settings.last_update_check * 1000).toLocaleString()}.`
          : 'Never checked.'}
        {' '}
        <a href={RELEASES_URL} onClick={(e) => { e.preventDefault(); openUrl(RELEASES_URL).catch(reportFailure); }}>All releases</a>
      </p>
      <Diagnostics version={version} />
    </section>
  );
}

/** What the backend knows about this install, asked once when About opens. */
type Backend = Pick<DiagFacts, 'platform' | 'dataDir' | 'home'>;

/**
 * Everything a bug report needs that the user would otherwise have to find
 * and type out, with a preview of exactly what will be copied.
 */
function Diagnostics({ version }: { version: string }) {
  const { settings, servers, keys, identities, portForwardings, sessions, recentErrors } = useAppStore();
  const { copied, failed, copy } = useCopy();
  const [backend, setBackend] = useState<Backend | null>(null);

  useEffect(() => {
    // Each answer on its own: a data folder that cannot be named is no
    // reason to report nothing else.
    const settle = (p: Promise<string>) => p.catch(() => 'unknown');
    Promise.all([settle(ipc.platform()), settle(ipc.dataDir()), settle(ipc.sftpLocalHome())])
      .then(([platform, dataDir, home]) => setBackend({ platform, dataDir, home }));
  }, []);

  // Built on every render rather than once, so the errors in it are the
  // ones up to the moment of the copy.
  const text = backend && formatDiagnostics(
    {
      version: version || 'unknown',
      ...backend,
      userAgent: navigator.userAgent,
      window: { width: window.innerWidth, height: window.innerHeight, scale: window.devicePixelRatio },
      counts: {
        hosts: servers.length,
        keys: keys.length,
        identities: identities.length,
        tunnels: portForwardings.length,
        tabs: sessions.length,
      },
      settings: {
        app_theme: settings.app_theme,
        font_size: settings.font_size,
        scrollback_lines: settings.scrollback_lines,
        host_key_policy: settings.host_key_policy,
        keepalive_interval_secs: settings.keepalive_interval_secs,
        connection_timeout_secs: settings.connection_timeout_secs,
        auto_reconnect: settings.auto_reconnect,
        restore_tabs: settings.restore_tabs,
        verify_transfers: settings.verify_transfers,
        auto_lock_minutes: settings.auto_lock_minutes,
      },
    },
    recentErrors,
  );

  return (
    <>
      <h3>Diagnostics</h3>
      <p className="form-hint">
        The version, the platform and its WebKit build, how many hosts and keys there are, and
        the errors this session has shown. No host names or user names, but an error message can
        name a host, so read it before pasting it into an issue.
      </p>
      <div className="settings-inline-row">
        <button className="btn-secondary btn-sm" disabled={!text} onClick={() => { if (text) void copy(text); }}>
          {copied ? 'Copied' : failed ? 'Copy failed' : 'Copy diagnostics'}
        </button>
      </div>
      {text && (
        <details className="diagnostics-preview">
          <summary>What will be copied</summary>
          <pre>{text}</pre>
        </details>
      )}
    </>
  );
}
