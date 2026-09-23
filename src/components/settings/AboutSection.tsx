import { useEffect, useState } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { openUrl } from '@tauri-apps/plugin-opener';
import { RELEASES_URL } from '../../updates';
import { useAppStore, reportFailure } from '../../store/appStore';
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
    </section>
  );
}
