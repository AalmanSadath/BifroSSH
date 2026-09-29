import { Sentry, type Detection, type Offer, type ReceiveSession, type SendSession, type Session } from 'zmodem.js';
import type { Terminal } from '@xterm/xterm';
import * as ipc from './ipc';

/**
 * ZMODEM in a terminal tab: `sz file` on the host sends a file here, `rz`
 * on the host asks for files from here.
 *
 * Every chunk of output goes through zmodem.js's Sentry, which passes it to
 * the terminal untouched until a transfer starts; then the protocol takes it
 * over until the transfer ends. The bytes on this side are read and written
 * through the backend a piece at a time, so a big file never sits in memory
 * whole.
 */

/** What the overlay shows while a transfer runs. */
export interface TransferProgress {
  direction: 'receive' | 'send';
  name: string;
  /** Bytes of the current file so far, and its size when the sender said. */
  done: number;
  total: number | null;
  /** 1-based, and how many there are in all when that is known. */
  fileIndex: number;
  fileCount: number | null;
}

export interface ZmodemHandlers {
  /** Bytes for the far end, in order; resolves once they are queued there. */
  send: (bytes: Uint8Array) => Promise<void>;
  /** The transfer is over, or was never one: logs and recordings resume. */
  done: () => void;
  /** Where received files go; null cancels. */
  chooseFolder: () => Promise<string | null>;
  /** What to send; null or empty cancels. */
  chooseFiles: () => Promise<string[] | null>;
  progress: (p: TransferProgress | null) => void;
  /** How a transfer ended, in words, for the terminal to show. */
  finished: (message: string, ok: boolean) => void;
}

export interface ZmodemHandle {
  /** Output from the session, which becomes terminal output or protocol. */
  consume: (buf: Uint8Array) => void;
  /** Whether a transfer holds the terminal, so keys are not typed into it. */
  active: () => boolean;
  /** Stops the transfer in progress, leaving no half-written file. */
  cancel: () => void;
}

/** Written per call rather than per byte, which is what makes a big file bearable. */
const WRITE_BATCH = 256 * 1024;
const READ_CHUNK = 64 * 1024;

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

const fromBase64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** The last part of a path, whichever separator it uses. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

class Cancelled extends Error {}

export function attachZmodem(term: Terminal, handlers: ZmodemHandlers): ZmodemHandle {
  let session: Session | null = null;
  /** Sends in order: each waits for the one before, so bytes never cross. */
  let sending: Promise<void> = Promise.resolve();
  let cancel: (() => void) | null = null;
  /** A file half written when a cancel came, for it to be taken away. */
  let partial: string | null = null;

  const sentry = new Sentry({
    to_terminal: (octets) => term.write(Uint8Array.from(octets)),
    sender: (octets) => {
      const bytes = Uint8Array.from(octets);
      sending = sending.then(() => handlers.send(bytes)).catch(() => {});
    },
    on_detect: (detection) => { void run(detection); },
    // What looked like the start of a transfer was not one after all.
    on_retract: () => { if (!session) handlers.done(); },
  });

  async function run(detection: Detection) {
    if (session) return;
    let current: Session;
    try {
      current = detection.confirm();
    } catch {
      return;
    }
    session = current;
    const stopped = new Promise<never>((_, reject) => {
      cancel = () => reject(new Cancelled());
    });
    stopped.catch(() => {});
    // Whatever the session is waiting on, a cancel ends the wait too:
    // zmodem.js leaves its promises unsettled once aborted.
    const orCancel = <T,>(p: Promise<T>) => Promise.race([p, stopped]);
    try {
      handlers.finished(current.type === 'receive'
        ? await receive(current, orCancel)
        : await sendFiles(current, orCancel), true);
    } catch (e) {
      if (!current.has_ended()) {
        try { current.abort(); } catch { /* already over */ }
      }
      if (partial) await ipc.localFileRemove(partial).catch(() => {});
      handlers.finished(e instanceof Cancelled ? 'Transfer cancelled' : `Transfer failed: ${e instanceof Error ? e.message : String(e)}`, false);
    } finally {
      partial = null;
      cancel = null;
      session = null;
      handlers.progress(null);
      await sending;
      handlers.done();
    }
  }

  async function receive(s: ReceiveSession, orCancel: <T>(p: Promise<T>) => Promise<T>): Promise<string> {
    const folder = await orCancel(handlers.chooseFolder());
    if (!folder) throw new Cancelled();
    let fileIndex = 0;
    let work: Promise<void> = Promise.resolve();
    const saved: string[] = [];
    const ended = new Promise<void>((resolve) => s.on('session_end', resolve));

    s.on('offer', (offer: Offer) => {
      // One file at a time, in the order they are offered.
      work = work.then(() => take(offer, folder, ++fileIndex, orCancel)).then((path) => { saved.push(path); });
    });
    s.start();
    await orCancel(ended);
    await orCancel(work);
    return saved.length === 1 ? `Saved ${saved[0]}` : `Saved ${saved.length} files to ${folder}`;
  }

  async function take(offer: Offer, folder: string, fileIndex: number, orCancel: <T>(p: Promise<T>) => Promise<T>): Promise<string> {
    const details = offer.get_details();
    const path = await orCancel(ipc.localFileCreate(folder, details.name));
    partial = path;
    const total = details.size ?? null;
    const fileCount = details.files_remaining ? fileIndex - 1 + details.files_remaining : null;
    let done = 0;
    let batch: Uint8Array[] = [];
    let batched = 0;
    let writing: Promise<void> = Promise.resolve();
    let writeError: unknown = null;
    const flush = () => {
      if (batched === 0) return;
      const joined = new Uint8Array(batched);
      let at = 0;
      for (const b of batch) { joined.set(b, at); at += b.length; }
      batch = [];
      batched = 0;
      writing = writing.then(() => ipc.localFileAppend(path, toBase64(joined))).catch((e) => { writeError = e; });
    };
    const report = () => handlers.progress({ direction: 'receive', name: baseName(path), done, total, fileIndex, fileCount });
    report();
    await orCancel(offer.accept({
      on_input: (payload) => {
        batch.push(Uint8Array.from(payload));
        batched += payload.length;
        done += payload.length;
        if (batched >= WRITE_BATCH) flush();
        report();
      },
    }));
    flush();
    await orCancel(writing);
    if (writeError) throw writeError;
    partial = null;
    return path;
  }

  async function sendFiles(s: SendSession, orCancel: <T>(p: Promise<T>) => Promise<T>): Promise<string> {
    const files = await orCancel(handlers.chooseFiles());
    if (!files || files.length === 0) throw new Cancelled();
    const infos = await orCancel(Promise.all(files.map((f) => ipc.localFileInfo(f))));
    let bytesLeft = infos.reduce((n, i) => n + i.size, 0);
    let sent = 0;

    for (let i = 0; i < files.length; i++) {
      const { size, mtime } = infos[i];
      const name = baseName(files[i]);
      const xfer = await orCancel(s.send_offer({
        name,
        size,
        mtime,
        files_remaining: files.length - i,
        bytes_remaining: bytesLeft,
      }));
      bytesLeft -= size;
      // Skipped by the receiver, usually because it has the file already.
      if (!xfer) continue;
      let offset = 0;
      handlers.progress({ direction: 'send', name, done: 0, total: size, fileIndex: i + 1, fileCount: files.length });
      while (offset < size) {
        const chunk = fromBase64(await orCancel(ipc.localFileReadChunk(files[i], offset, READ_CHUNK)));
        if (chunk.length === 0) break;
        xfer.send(chunk);
        offset += chunk.length;
        // Read no further ahead than the connection is taking the bytes.
        await orCancel(sending);
        handlers.progress({ direction: 'send', name, done: offset, total: size, fileIndex: i + 1, fileCount: files.length });
      }
      await orCancel(xfer.end());
      sent++;
    }
    await orCancel(s.close());
    const skipped = files.length - sent;
    return `Sent ${sent} ${sent === 1 ? 'file' : 'files'}${skipped ? `; the host skipped ${skipped}` : ''}`;
  }

  return {
    consume: (buf) => sentry.consume(buf),
    active: () => session !== null,
    cancel: () => cancel?.(),
  };
}
