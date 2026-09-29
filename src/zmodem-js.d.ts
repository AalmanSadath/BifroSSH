/**
 * The parts of zmodem.js the terminal uses. The package ships no types; this
 * is written from its source (src/zsentry.js, src/zsession.js), and names only
 * what `src/zmodem.ts` calls.
 */
declare module 'zmodem.js' {
  export interface FileDetails {
    name: string;
    size?: number | null;
    mtime?: number | Date | null;
    files_remaining?: number | null;
    bytes_remaining?: number | null;
  }

  interface SessionBase {
    type: 'send' | 'receive';
    on(event: 'session_end', handler: () => void): this;
    abort(): void;
    has_ended(): boolean;
  }

  /** The far end is sending (it ran `sz`): offers arrive to be accepted or skipped. */
  export interface ReceiveSession extends SessionBase {
    type: 'receive';
    on(event: 'offer', handler: (offer: Offer) => void): this;
    on(event: 'session_end', handler: () => void): this;
    start(): void;
  }

  /** The far end is receiving (it ran `rz`): files are offered to it. */
  export interface SendSession extends SessionBase {
    type: 'send';
    /** Resolves with a transfer, or undefined when the receiver skips the file. */
    send_offer(details: FileDetails): Promise<Transfer | undefined>;
    close(): Promise<void>;
  }

  export type Session = ReceiveSession | SendSession;

  export interface Offer {
    get_details(): FileDetails;
    /** Resolves once the whole file has arrived. */
    accept(opts: { on_input: (payload: number[]) => void }): Promise<unknown>;
    skip(): void;
  }

  export interface Transfer {
    send(bytes: Uint8Array | number[]): void;
    /** Resolves once the receiver has acknowledged the end of the file. */
    end(bytes?: Uint8Array | number[]): Promise<void>;
  }

  export interface Detection {
    confirm(): Session;
    deny(): void;
    is_valid(): boolean;
    get_session_role(): 'send' | 'receive';
  }

  export class Sentry {
    constructor(options: {
      to_terminal: (octets: number[]) => void;
      sender: (octets: number[]) => void;
      on_detect: (detection: Detection) => void;
      on_retract: () => void;
    });
    consume(input: Uint8Array | ArrayBuffer | number[]): void;
    get_confirmed_session(): Session | null;
  }
}
