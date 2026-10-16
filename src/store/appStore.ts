import { create } from 'zustand';
import { createAppSlice } from './slices/app';
import { createBootstrapSlice } from './slices/bootstrap';
import { createConnectSlice } from './slices/connect';
import { createHistorySlice } from './slices/history';
import { createLibrarySlice } from './slices/library';
import { createProbesSlice } from './slices/probes';
import { createReconnectSlice } from './slices/reconnect';
import { createRecordsSlice } from './slices/records';
import { createSessionsSlice } from './slices/sessions';
import { createSettingsSlice } from './slices/settings';
import { createSplitsSlice } from './slices/splits';
import { createTunnelsSlice } from './slices/tunnels';
import type { AppStore } from './types';

// What the rest of the app imports from here, wherever it now lives.
export { broadcastTargets } from './slices/sessions';
export { pruneSplit } from './slices/splits';
export type { AutostartTrigger } from './slices/tunnels';
export { cachedAppTheme, resolveAccent, resolveAppTheme } from './themeCache';
export { buildJumpChain, containerTabName, resolveServerAuth } from './auth';
export type { ContainersConn, ResolvedAuth } from './auth';
export type { AppStore } from './types';

export const useAppStore = create<AppStore>()((...a) => ({
  ...createAppSlice(...a),
  ...createBootstrapSlice(...a),
  ...createConnectSlice(...a),
  ...createHistorySlice(...a),
  ...createLibrarySlice(...a),
  ...createProbesSlice(...a),
  ...createReconnectSlice(...a),
  ...createRecordsSlice(...a),
  ...createSessionsSlice(...a),
  ...createSettingsSlice(...a),
  ...createSplitsSlice(...a),
  ...createTunnelsSlice(...a),
}));

/**
 * Catch handler for an action whose caller has nowhere to put an error.
 *
 * A delete fired from a confirm modal, or a setting toggled from a row, has no
 * error slot of its own; every one of them was called without `await` and
 * without `.catch`, so the modal closed and the failure went nowhere. The
 * lists stayed honest, because the store only patches state after the await
 * resolves, but nothing said the thing had not happened.
 */
export function reportFailure(e: unknown) {
  console.error(e);
  useAppStore.getState().setActionError(String(e));
}
