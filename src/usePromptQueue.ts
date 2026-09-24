import { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';

/**
 * A queue of prompts the backend raises, and the modal's way of answering
 * them one at a time.
 *
 * Host key questions and keyboard-interactive rounds are emitted globally
 * rather than per connect, so one modal serves terminal sessions, SFTP,
 * tunnels and OS detection alike, and two connects racing each other produce
 * two prompts rather than one lost one. Each kind also has a companion
 * `-cancel` event: a connect that timed out or was cancelled before the user
 * answered retracts its question instead of leaving a modal pointing at
 * nothing.
 *
 * A repeat of a request already in the queue is ignored. The backend does not
 * send one today, but a retry that did would otherwise stack two identical
 * modals the user has to answer twice.
 */
export function usePromptQueue<T extends { request_id: string }>(
  event: string,
): [T[], (requestId: string) => void] {
  const [queue, setQueue] = useState<T[]>([]);

  useEffect(() => {
    const dismiss = (requestId: string) =>
      setQueue((q) => q.filter((p) => p.request_id !== requestId));

    const unlisten = Promise.all([
      listen<T>(event, (e) => {
        setQueue((q) => (q.some((p) => p.request_id === e.payload.request_id) ? q : [...q, e.payload]));
      }),
      listen<{ request_id: string }>(`${event}-cancel`, (e) => dismiss(e.payload.request_id)),
    ]);

    return () => {
      unlisten.then((fns) => fns.forEach((fn) => fn()));
    };
  }, [event]);

  const dismiss = (requestId: string) =>
    setQueue((q) => q.filter((p) => p.request_id !== requestId));

  return [queue, dismiss];
}
