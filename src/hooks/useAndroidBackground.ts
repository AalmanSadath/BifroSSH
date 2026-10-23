import { useEffect, useRef } from 'react';
import * as ipc from '../ipc';
import { useAppStore } from '../store/appStore';
import { disconnectHeld, useHeldCount } from '../heldConnections';
import { isAndroid } from '../platform';

declare global {
  interface Window {
    /** The background notification's "Disconnect all" (MainActivity). */
    __bifrosshDisconnectAll?: () => void;
    /** The default network changed or went (MainActivity.watchNetwork). */
    __bifrosshNetwork?: () => void;
    /** A volume key, +1 or -1, while they belong to the terminal (MainActivity). */
    __bifrosshVolume?: (step: number) => void;
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

/**
 * The volume keys as the terminal's text size on Android, while a terminal
 * is in front and the setting is on. Anywhere else they stay the volume.
 */
export function useVolumeZoom(terminalInFront: boolean): void {
  const enabled = useAppStore((s) => s.settings.volume_keys_zoom) && terminalInFront;
  const activeTabId = useAppStore((s) => s.activeTabId);
  const zoomSession = useAppStore((s) => s.zoomSession);
  const tabRef = useRef(activeTabId);
  tabRef.current = activeTabId;

  useEffect(() => {
    if (!isAndroid) return;
    ipc.androidVolumeKeys(enabled).catch(() => {});
  }, [enabled]);

  useEffect(() => {
    if (!isAndroid) return;
    window.__bifrosshVolume = (step) => {
      if (tabRef.current) zoomSession(tabRef.current, step);
    };
    return () => { delete window.__bifrosshVolume; };
  }, [zoomSession]);
}

/**
 * After the network changes on Android, finds the connections left on the
 * old one and brings everything waiting to reconnect back at once.
 *
 * The check pings each terminal connection and ends, as dropped, those that
 * do not answer; they then take the usual reconnect path. Tabs and tunnels
 * already waiting out a backoff are tried straight away. An SFTP pane finds
 * out on its next action, as it does today.
 */
export function useNetworkChange(): void {
  useEffect(() => {
    if (!isAndroid) return;
    window.__bifrosshNetwork = () => {
      void ipc.sshCheckSessions()
        .catch(() => 0)
        .then(() => {
          const s = useAppStore.getState();
          s.retryTabsNow();
          s.retryTunnelsNow();
        });
    };
    return () => { delete window.__bifrosshNetwork; };
  }, []);
}
