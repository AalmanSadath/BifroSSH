import { useEffect, useState } from 'react';
import * as ipc from './ipc';
import { isAndroid } from './platform';

/**
 * Whether the user's files can be used by path: always on a desktop, and on
 * Android once All files access is granted. Read again whenever the app comes
 * back to the front, which is how the user returns from granting it.
 */
export function useStorageAccess(): boolean {
  const [granted, setGranted] = useState(!isAndroid);
  useEffect(() => {
    if (!isAndroid) return;
    const check = () => { ipc.storageAccess().then(setGranted).catch(() => {}); };
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    check();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);
  return granted;
}

/** Says what is missing and opens the page that grants it. */
export function StorageAccessNotice({ what }: { what: string }) {
  return (
    <div className="storage-notice">
      <p>BifroSSH needs All files access to {what}.</p>
      <button
        type="button"
        className="btn-primary btn-sm"
        onClick={() => { ipc.requestStorageAccess().catch(() => {}); }}
      >
        Grant file access
      </button>
    </div>
  );
}
