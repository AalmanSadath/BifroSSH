import { afterEach, describe, expect, it, vi } from 'vitest';

const unlisten = vi.fn();
let deliver: ((event: { payload: unknown }) => void) | null = null;
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_channel: string, handler: (event: { payload: unknown }) => void) => {
    deliver = handler;
    return unlisten;
  }),
}));

import { listen } from '@tauri-apps/api/event';
import { withConnectLog } from './connectLog';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('withConnectLog', () => {
  it('passes each line on, and keeps listening a moment after success', async () => {
    vi.useFakeTimers();
    const lines: unknown[] = [];
    const got = await withConnectLog('c1', (e) => lines.push(e), async () => {
      deliver?.({ payload: { kind: 'auth', message: 'hello' } });
      return 'sid';
    });
    expect(got).toBe('sid');
    expect(listen).toHaveBeenCalledWith('ssh-connect-log:c1', expect.any(Function));
    expect(lines).toEqual([{ kind: 'auth', message: 'hello' }]);
    expect(unlisten).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  /** The line saying why a connect failed arrives last, so a failure waits too. */
  it('keeps listening a moment after a failure as well, and passes the failure on', async () => {
    vi.useFakeTimers();
    await expect(withConnectLog('c2', () => {}, async () => { throw new Error('refused'); }))
      .rejects.toThrow('refused');
    expect(unlisten).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
