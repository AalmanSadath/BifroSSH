import { useEffect } from 'react';
import * as ipc from '../ipc';
import { useAppStore } from '../store/appStore';
import { disconnectHeld, useHeldCount } from '../heldConnections';
import { isAndroid } from '../platform';

declare global {
  interface Window {
    /** The background notification's "Disconnect all" (MainActivity). */
    __bifrosshDisconnectAll?: () => void;
  }
}

/**
 * Keeps connections alive while the app is out of sight on Android.
 *
 * Every terminal tab, running or retrying tunnel and open SFTP pane counts.
 * While any does, a foreground service with a notification keeps the process
 * from being frozen; at none it stops. The notification's "Disconnect all"
 * comes back here.
 */
export function useAndroidKeepAlive(): void {
  const tabs = useAppStore((s) => s.sessions.length);
  const tunnels = useAppStore((s) => s.activeTunnelIds.size + s.retryingTunnelIds.size);
  const keepAwake = useAppStore((s) => s.settings.keep_awake);
  const sftp = useHeldCount();
  const count = tabs + tunnels + sftp;

  useEffect(() => {
    if (!isAndroid) return;
    ipc.androidKeepAlive(count, keepAwake).catch(() => {});
  }, [count, keepAwake]);

  useEffect(() => {
    if (!isAndroid) return;
    window.__bifrosshDisconnectAll = () => {
      const s = useAppStore.getState();
      for (const tab of s.sessions) {
        if (tab.session_id) ipc.sshDisconnect(tab.session_id).catch(() => {});
        s.removeSession(tab.tab_id);
      }
      for (const id of s.activeTunnelIds) s.stopTunnel(id).catch(() => {});
      // A retrying tunnel has nothing running to stop; dropping it from the
      // set is what ends its retries.
      useAppStore.setState({ retryingTunnelIds: new Set() });
      disconnectHeld();
    };
    return () => { delete window.__bifrosshDisconnectAll; };
  }, []);
}

