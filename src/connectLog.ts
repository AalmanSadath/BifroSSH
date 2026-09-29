import { listen } from '@tauri-apps/api/event';
import type { LogEntry } from './types';

/**
 * How long the log is still listened to once the connect has settled. The
 * backend emits its last lines just before the command returns, and those
 * race the response over the same bridge, so unlistening on the response
 * itself loses the end of the transcript.
 */
const TRAILING_MS = 1000;

/**
 * Runs `connect` while passing every line the backend narrates for
 * `connectId` to `onLog`, and keeps listening a moment after it settles,
 * whichever way it went.
 *
 * Terminal tabs, the SFTP panel and the Containers panel each wrote this
 * out, and had drifted: one stopped listening at once on a failure, and so
 * could lose the line saying why.
 */
export async function withConnectLog<T>(
  connectId: string,
  onLog: (entry: LogEntry) => void,
  connect: () => Promise<T>,
): Promise<T> {
  const unlisten = await listen<LogEntry>(`ssh-connect-log:${connectId}`, (event) => onLog(event.payload));
  try {
    return await connect();
  } finally {
    setTimeout(unlisten, TRAILING_MS);
  }
}
