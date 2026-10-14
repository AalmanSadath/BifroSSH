import * as ipc from '../ipc';
import { tabsToSave } from '../sessionRestore';
import type { Codeprint, PortForwarding, SessionTab } from '../types';
import type { NamedTheme } from '../styles/themes';
import type { AppStore } from './types';

// These three collections used to live here. They are now kept in the Rust
// store alongside servers and keys; the keys remain only so existing data can
// be migrated across once.
const CUSTOM_THEMES_KEY = 'bifrossh_custom_themes';
const CODEPRINTS_KEY = 'bifrossh_codeprints';
const PORT_FORWARDINGS_KEY = 'bifrossh_port_forwardings';

/**
 * Persists a collection to the backing store.
 *
 * Deliberately fire-and-forget: these are edited far more often than they fail
 * to save, and blocking the UI on a disk write would be worse than logging it.
 */
export function persist(get: () => AppStore, save: () => Promise<void>) {
  // Reported rather than only logged. The state has already been changed by
  // the time this runs, so a failure here means the screen and the disk have
  // parted company, which is exactly the thing worth saying out loud. This is
  // what `reportFailure` does, reached through `get` so this module does not
  // have to import the store it is part of.
  save().catch((e: unknown) => {
    console.error(e);
    get().setActionError(String(e));
  });
}

/**
 * Writes down which hosts have a tab open, so the next launch can put them
 * back. Called after every change to the strip rather than at shutdown:
 * the window can close without the app being asked first.
 */
export function saveOpenTabs(sessions: SessionTab[]) {
  ipc.saveOpenTabs(tabsToSave(sessions)).catch(() => {
    // Not worth a banner. Worst case a restart opens the previous strip.
  });
}

/**
 * Commands waiting to be written, by host, oldest first.
 *
 * Batched because every save rewrites and re-encrypts the whole data file,
 * and a busy session runs a command every few seconds. A crash loses at most
 * the last few, which only means a suggestion missing.
 */
const queuedCommands = new Map<string, string[]>();
let commandFlush: ReturnType<typeof setTimeout> | null = null;
const COMMAND_FLUSH_MS = 5_000;

export function queueCommand(serverId: string, command: string) {
  queuedCommands.set(serverId, [...(queuedCommands.get(serverId) ?? []), command]);
  commandFlush ??= setTimeout(flushCommands, COMMAND_FLUSH_MS);
}

function flushCommands() {
  commandFlush = null;
  for (const [serverId, commands] of queuedCommands) {
    ipc.recordCommands(serverId, commands).catch(() => {
      // Not worth a banner: the commands are still suggested this session.
    });
  }
  queuedCommands.clear();
}

export function dropQueuedCommands(serverId: string | null) {
  if (serverId === null) queuedCommands.clear();
  else queuedCommands.delete(serverId);
}

function readLegacy<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Moves anything still in localStorage into the backing store, once.
 *
 * Only runs when the store side is empty, so it cannot overwrite newer data,
 * and the localStorage key is removed only after the save has succeeded, so a
 * failure here leaves the original data untouched to be retried next launch.
 */
export async function migrateLegacyStorage(current: {
  portForwardings: PortForwarding[];
  codeprints: Codeprint[];
  customThemes: Record<string, NamedTheme>;
}): Promise<typeof current> {
  const result = { ...current };

  const legacyPfs = readLegacy<PortForwarding[]>(PORT_FORWARDINGS_KEY, []);
  if (legacyPfs.length > 0 && current.portForwardings.length === 0) {
    await ipc.savePortForwardings(legacyPfs);
    result.portForwardings = legacyPfs;
  }
  if (legacyPfs.length === 0 || result.portForwardings === legacyPfs) {
    localStorage.removeItem(PORT_FORWARDINGS_KEY);
  }

  const legacyCps = readLegacy<Codeprint[]>(CODEPRINTS_KEY, []);
  if (legacyCps.length > 0 && current.codeprints.length === 0) {
    await ipc.saveCodeprints(legacyCps);
    result.codeprints = legacyCps;
  }
  if (legacyCps.length === 0 || result.codeprints === legacyCps) {
    localStorage.removeItem(CODEPRINTS_KEY);
  }

  const legacyThemes = readLegacy<Record<string, NamedTheme>>(CUSTOM_THEMES_KEY, {});
  if (Object.keys(legacyThemes).length > 0 && Object.keys(current.customThemes).length === 0) {
    await ipc.saveCustomThemes(legacyThemes);
    result.customThemes = legacyThemes;
  }
  if (Object.keys(legacyThemes).length === 0 || result.customThemes === legacyThemes) {
    localStorage.removeItem(CUSTOM_THEMES_KEY);
  }

  return result;
}
