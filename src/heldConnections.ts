import { useSyncExternalStore } from 'react';

/**
 * Connections that live outside the store, which today means an SFTP pane's,
 * so the Android background service can count them and "Disconnect all" can
 * reach them. Tabs and tunnels are counted from the store directly.
 */
const held = new Set<() => void>();
const listeners = new Set<() => void>();

function changed() {
  listeners.forEach((l) => l());
}

/** Registers one open connection, with how to close it. Returns its release. */
export function holdConnection(disconnect: () => void): () => void {
  const entry = () => disconnect();
  held.add(entry);
  changed();
  return () => {
    if (held.delete(entry)) changed();
  };
}

/** Closes every registered connection. */
export function disconnectHeld(): void {
  [...held].forEach((d) => d());
}

/** How many are registered, as React state. */
export function useHeldCount(): number {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => listeners.delete(l); },
    () => held.size,
  );
}
