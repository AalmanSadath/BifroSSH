/**
 * `Server.os` for a host nobody has asked yet.
 *
 * The two sentinels are the whole state of OS detection for a host, and the
 * difference decides whether it is asked again: this one means try, and
 * [`UNKNOWN_OS`] means it was tried and the host could not say. Both draw the
 * generic server icon, so only the store tells them apart.
 */
export const UNDETECTED_OS = '';

/**
 * `Server.os` for a host that was asked and could not say.
 *
 * The backend writes this value, so the two must agree: see `UNKNOWN_OS` in
 * `models.rs`.
 */
export const UNKNOWN_OS = 'server';

/**
 * What the backend puts in `encrypted_password` in place of the ciphertext.
 *
 * The password itself never crosses; a record that has one is marked, and
 * `resolveServerAuth` asks for the real thing only when it is about to
 * connect. The exact string is `STORED` in `commands/records.rs`, and the two
 * must agree.
 */
export const STORED = '[stored]';

/** How a connection proves who it is. Spelled `auth_type` on the wire. */
export type AuthType = 'key' | 'password' | 'keyboard-interactive' | 'agent';

export interface Server {
  id: string;
  name: string;
  host: string;
  port: number;
  identity_id: string | null;
  username: string | null;
  encrypted_password: string | null;
  key_id: string | null;
  theme: string | null;
  os: string;
  connection_timeout: number | null;
  auth_kind: AuthKind | null;
  /**
   * Id of another saved server to reach this one through, the equivalent of
   * OpenSSH's ProxyJump. That server's own proxy_jump is followed too, so a
   * chain of bastions is expressed one link at a time.
   */
  proxy_jump: string | null;
  /**
   * ssh's -A. While a session is open, programs on this host can use the
   * local agent's keys, and so can anyone with root there. Off by default.
   */
  forward_agent: boolean;
  /** Every session to this host is logged to a file from its first byte. */
  log_sessions: boolean;
  /** Hosts are sectioned by this on the hosts page. Null or empty: no group. */
  group: string | null;
  /** One line sent to the shell as if typed, once it has finished saying hello. */
  run_on_connect: string | null;
  /** Keep that line out of the terminal, by removing its echo. On by default. */
  hide_run_on_connect: boolean;
  /** Free text the user keeps about this host; searched with the rest. */
  notes: string | null;
  /** The terminal type the PTY asks for; null is xterm-256color. */
  term: string | null;
  /** Variables to ask the server to set, one NAME=value per line, as typed. */
  env: string | null;
}

/** A directory saved for one click in the SFTP panel. */
export interface SftpBookmark {
  id: string;
  /** The host it belongs to; null is the local pane. */
  server_id: string | null;
  label: string;
  path: string;
}

/** Payload of the `sftp-progress` event, emitted as bytes move. */
export interface TransferProgress {
  /** The id the panel gave the transfer when it queued it. */
  transfer_id: string;
  file_name: string;
  transferred: number;
  total: number;
  /**
   * The byte this file's copy started at, which is not zero when an
   * unfinished file was continued. Needed for the rate: without it an earlier
   * attempt's bytes are counted against this attempt's few seconds.
   */
  resumed_from: number;
  /** 1-based position within a batch; 1/1 for a single file. */
  file_index: number;
  file_count: number;
}

/** What `sftp_upload`, `sftp_download` and `sftp_copy_remote_to_remote` return. */
export interface TransferSummary {
  files: number;
  directories: number;
  /** Symlinks are never copied; following one risks a loop. */
  skipped_symlinks: number;
  /** Left alone because one was already there and the answer was skip. */
  skipped_existing: number;
  /** Files written under a name of their own because one was already there. */
  renamed: number;
  /** True when the user stopped it; `files` then counts what arrived. */
  cancelled: boolean;
  /** Files continued from an unfinished copy rather than started over. */
  resumed: number;
  /**
   * Of those, the ones whose finished copy did not match the source, by path
   * relative to the transfer root; a single file is the empty string.
   */
  mismatched: string[];
  /** Unfinished files left at the destination, ready to be continued. */
  resumable: number;
  /** What ended the batch early, where something did. */
  failed: string | null;
  /** Where it wrote, directory and name together; null when nothing was. */
  landed: string | null;
  /** Files read back and compared with the source; 0 when that was off. */
  verified: number;
}

/** How two folders differ; see `compare_trees` in Rust. */
export interface TreeDiff {
  /** Paths, relative to each root, present on one side only. */
  only_left: string[];
  only_right: string[];
  /** Same path on both sides, different content. */
  differing: string[];
  /** Files the same on both sides. */
  same: number;
  /** True when the user stopped it; the lists are then partial. */
  cancelled: boolean;
  /** Files whose sizes matched and so had to be read and hashed. */
  hashed: number;
}

/** What a transfer does with a file that is already at the destination. */
export type Conflict = 'overwrite' | 'skip' | 'keep_both' | 'resume';

/** Which pairing a conflict check is for; decides which session ids matter. */
export type TransferKind = 'upload' | 'download' | 'copy';

/**
 * One jump host as the backend expects it. The chain is walked and its
 * credentials resolved on this side; a key here is still just an id, and the
 * backend goes to the keychain for the material.
 */
export interface JumpHopParams {
  host: string;
  port: number;
  username: string;
  auth_type: AuthType;
  auth_value: string;
}

/**
 * Everything `ssh_connect` needs. Sent as one object rather than a dozen
 * arguments because the backend takes it as one struct.
 */
export interface ConnectRequest {
  server_id: string;
  username: string;
  auth_type: AuthType;
  auth_value: string;
  cols: number;
  rows: number;
  /** Names the channel the connection log is narrated on. */
  connect_id: string;
  jumps: JumpHopParams[];
}

/** The same, for a host that was typed in rather than saved. */
export interface QuickConnectRequest {
  host: string;
  port: number;
  username: string;
  auth_type: AuthType;
  auth_value: string;
  cols: number;
  rows: number;
  connect_id: string;
  jumps: JumpHopParams[];
}

/**
 * Auth modes that are not expressed by a stored credential.
 * 'keyboard-interactive' is PAM/2FA challenge-response; 'agent' uses keys held
 * by a running ssh-agent.
 */
export type AuthKind = 'keyboard-interactive' | 'agent';

export interface Identity {
  id: string;
  name: string;
  username: string;
  key_id: string | null;
  encrypted_password: string | null;
  auth_kind: AuthKind | null;
  /** Pins one ssh-agent key by fingerprint; null tries every key it offers. */
  agent_fingerprint: string | null;
}

export interface KeyEntry {
  id: string;
  name: string;
  key_path: string | null;
  encrypted_key: string | null;
  encrypted_passphrase: string | null;
  algorithm: string | null;
}

/** The material behind a saved key, decrypted for the one caller that asked. */
export interface KeyContent {
  private_pem: string;
  /** Derived from the private key, so absent only when it could not be read. */
  public_openssh: string | null;
  passphrase: string | null;
}

export interface GeneratedKey {
  private_pem: string;
  public_openssh: string;
}

/** What one reachability check found; see `probe_host` in Rust. */
export interface HostProbe {
  reachable: boolean;
  /** Round trip in milliseconds; 0 when it did not answer. */
  ms: number;
  error: string | null;
}

/**
 * A host's check as the cards see it: in flight, not attempted, or a result
 * with the time it landed.
 */
export type ProbeState = 'running' | 'skipped' | (HostProbe & { at: number });

/** A category of the settings panel, and the rail item that shows it. */
export type SettingsSection =
  | 'appearance'
  | 'terminal'
  | 'shortcuts'
  | 'connection'
  | 'security'
  | 'data'
  | 'about';

/** One keyword highlighting rule. */
export interface HighlightRule {
  /** A JavaScript regular expression, as typed. */
  pattern: string;
  /** An ANSI colour name, resolved against the tab's theme. */
  color: string;
  case_sensitive: boolean;
}

export interface Settings {
  theme: string;
  font_size: number;
  font_family: string;
  cursor_style: CursorStyle;
  cursor_blink: boolean;
  app_theme: AppTheme;
  connection_timeout_secs: number;
  show_hover_hints: boolean;
  sftp_inactivity_timeout_secs: number;
  host_key_policy: HostKeyPolicy;
  /**
   * `#rrggbb` the user picked, or null to follow the desktop's accent and fall
   * back to the palette's own where the desktop has none.
   */
  accent_color: string | null;
  /** Seconds between keepalives on terminal and tunnel connections; 0 is off. */
  keepalive_interval_secs: number;
  /** Minutes of no input before the vault locks; 0 is off. */
  auto_lock_minutes: number;
  /** Lock before the machine sleeps. */
  lock_on_suspend: boolean;
  /** Lines a terminal keeps above the screen. */
  scrollback_lines: number;
  /** Where session logs go; null is the app's own logs folder. */
  session_log_dir: string | null;
  /** Ask GitHub once a day whether a newer release exists. */
  check_for_updates: boolean;
  /** When the last check ran, epoch seconds; 0 for never. */
  last_update_check: number;
  /** Bring a dropped terminal back on its own. */
  auto_reconnect: boolean;
  /** Tries before giving up; 0 keeps trying. */
  auto_reconnect_attempts: number;
  /** Open last time's tabs at launch and connect them. */
  restore_tabs: boolean;
  /** Read both copies back after a transfer and compare them. */
  verify_transfers: boolean;
  /**
   * Keyboard bindings the user changed, action id to comma-joined chords;
   * an empty string unbinds. Only the changes: see `resolve` in
   * `src/shortcuts.ts`.
   */
  shortcuts: Record<string, string>;
  /** Colour what `highlight_rules` match in terminal output. */
  highlight_enabled: boolean;
  /** Applied in order; the first rule to match a stretch of text wins it. */
  highlight_rules: HighlightRule[];
}

/** How the user chose to keep the master key on the first run screen. */
export type VaultInitMode = 'secret-file' | 'passphrase-only' | 'keyring-and-passphrase';

/** State of the master key at startup. */
export interface VaultStatus {
  locked: boolean;
  /** No key has ever been made here, so the user chooses how to keep it. */
  setup_required: boolean;
  keyring_available: boolean;
  /** Keyring is present and holds the key, but is locked. */
  keyring_locked: boolean;
  /** Set when the keystore cannot be opened at all; no passphrase helps. */
  error: string | null;
}

/** Where the key that encrypts data.json is kept. */
export interface KeystoreStatus {
  source: 'keyring' | 'file' | 'passphrase';
  passphrase_set: boolean;
  /** Keyring is not allowed to open the vault; the passphrase is required. */
  always_ask: boolean;
  /** Whether a keyring answered just now, which can differ from `source`. */
  keyring_available: boolean;
  /** Present but locked, which the user can undo by unlocking it. */
  keyring_locked: boolean;
}

export type CursorStyle = 'block' | 'underline' | 'bar';

/**
 * `system` is a choice about where the answer comes from, not a palette: it
 * resolves to light or dark from what the desktop reports, and never to
 * amoled, which no desktop can ask for.
 */
export type AppTheme = 'system' | 'dark' | 'light' | 'amoled';

/** The three palettes that can actually be painted. */
export type ResolvedTheme = 'dark' | 'light' | 'amoled';

/** What the desktop says about itself, as far as it says anything. */
export interface SystemAppearance {
  color_scheme: 'dark' | 'light' | 'no-preference';
  /** `#rrggbb`, or null on a desktop that exposes no accent. */
  accent: string | null;
}

/** A mismatched key is blocked under all three policies. */
export type HostKeyPolicy = 'ask' | 'accept-new' | 'strict';

export type HostKeyDecision = 'trust' | 'once' | 'replace' | 'reject';

export interface HostKeyPromptEvent {
  request_id: string;
  connect_id: string | null;
  host: string;
  port: number;
  username: string | null;
  status: 'unknown' | 'mismatch' | 'revoked';
  key_type: string;
  fingerprint: string;
  existing_key_type: string | null;
  existing_fingerprint: string | null;
  source: string | null;
  line: number | null;
  /** A jump host on the way to the requested server, not the server itself. */
  is_jump: boolean;
}

export interface SshConfigHost {
  alias: string;
  hostname: string;
  user: string | null;
  port: number | null;
  identity_file: string | null;
  /**
   * The config's ProxyJump value, verbatim, hops and all. Resolved to saved
   * servers on import, but only when every hop is imported alongside it.
   */
  proxy_jump: string | null;
}

export interface SshConfigScan {
  hosts: SshConfigHost[];
  /** Files pulled in by `Include`, in the order they were read. */
  included_files: string[];
  /**
   * Files an `Include` named that could not be read. A pattern matching
   * nothing is normal and is not in here, so anything present means hosts are
   * missing.
   */
  unreadable_includes: string[];
}

export interface SshConfigImportResult {
  imported: number;
  skipped_existing: number;
  keys_linked: number;
  jumps_linked: number;
}

/** Which client an export came from. */
export type ImportSource = 'termius' | 'putty' | 'moba_xterm';

/** One host in another client's export, as the import dialog shows it. */
export interface ScannedHost {
  name: string;
  host: string;
  port: number;
  username: string | null;
  group: string | null;
  /** A saved host already has this address, port and user. */
  already_here: boolean;
  /** The file carries a password for it; the password itself stays in the backend. */
  has_password: boolean;
}

export interface ClientScan {
  source: ImportSource;
  hosts: ScannedHost[];
  /** Entries in the file that are not ssh hosts, one sentence each. */
  skipped: string[];
}

export interface ClientImportResult {
  imported: number;
  skipped_existing: number;
  passwords_saved: number;
  groups_created: number;
}

export interface AgentKeyInfo {
  algorithm: string;
  /** No comment field: russh-keys discards it while parsing agent identities. */
  fingerprint: string;
}

export interface AuthPromptField {
  prompt: string;
  /** False for secrets — the server decides, and those stay masked. */
  echo: boolean;
}

export interface AuthPromptEvent {
  request_id: string;
  connect_id: string | null;
  host: string;
  username: string;
  name: string;
  instructions: string;
  prompts: AuthPromptField[];
}

export interface KnownHostEntry {
  host: string;
  port: number;
  key_type: string;
  fingerprint: string;
  source: string;
  line: number;
}

export interface LogEntry {
  message: string;
  kind: string;
}

/** A tab written down at close, so the next launch can put it back. */
export interface OpenTab {
  server_id: string;
  /** The name the user gave it, absent when they never did. */
  title?: string | null;
}

export interface SessionTab {
  /**
   * The tab's identity: the connect id it was born with, never changed.
   * Everything that names a tab, from the strip to the theme override, uses
   * this. It used to be the backend session id, which meant a reconnect was
   * a new tab and the scrollback went with the old one.
   */
  tab_id: string;
  /** The live backend session, or null while connecting or after a drop. */
  session_id: string | null;
  server_name: string;
  /**
   * The name the user gave this tab, absent until they give it one. Kept
   * apart from `server_name`, which names the host and the files this
   * session writes: two tabs on one host are told apart by what they are
   * for, not by the counter on the second one's name.
   */
  title?: string;
  server_id: string;
  /**
   * `dropped` is a connection that went away under a tab that is kept: the
   * terminal stays mounted with its scrollback and offers to reconnect.
   */
  status: 'connecting' | 'connected' | 'dropped' | 'error';
  /** A reconnect is in flight for a dropped tab. */
  reconnecting?: boolean;
  /** When the next automatic attempt fires, epoch ms; the banner counts down to it. */
  retryAt?: number;
  /** Which attempt that will be, 1-based. */
  retryAttempt?: number;
  /** Set when the automatic attempts ran out, so the banner says so once. */
  gaveUpAfter?: number;
  /**
   * Typed input goes to every other tab marked the same way. The user's
   * choice, so it outlives a drop and a reconnect.
   */
  broadcast?: boolean;
  /**
   * Output is being written to a file in the session logs folder: turned
   * on for this tab, or by the host's setting. Only the first is shown on
   * the tab; a host that always logs is set and forgotten.
   */
  logging?: 'tab' | 'host';
  connect_id?: string;
  error?: string;
  logs?: LogEntry[];
  quick_info?: { host: string; port: number; username: string };
}

/** Payload of `ssh-closed:{session_id}`. */
/** Payload of `tunnel-closed`: a tunnel ended without being asked to. */
export interface TunnelClosed {
  pf_id: string;
  reason: 'dropped';
}

export interface SshClosed {
  reason: 'exited' | 'closed' | 'dropped';
}

export interface Codeprint {
  id: string;
  name: string;
  command: string;
}

export interface PortForwarding {
  id: string;
  label: string;
  type: 'local' | 'remote' | 'dynamic';
  bind_address: string;
  local_port: number | null;
  intermediate_host_id: string | null;
  remote_host_id: string | null;
  remote_port: number | null;
  dest_address: string;
  dest_port: number | null;
  /** Start when the app opens or the vault unlocks. */
  autostart_on_launch: boolean;
  /** Start when a session opens to the rule's own host. */
  autostart_on_connect: boolean;
}

/**
 * What `save_server` and `save_identity` accept.
 *
 * Everything is optional but the fields that identify the record, matching the
 * `#[serde(default)]`s on the Rust structs: a form that has not been shown a
 * field should not have to invent a value for it. An empty `id` creates.
 */
export type ServerInput = Partial<Server> & { name: string; host: string; port: number };

export type IdentityInput = Partial<Identity> & { name: string; username: string };

/** A local file or directory, as `sftp_list_local` reports it. */
export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number | null;
  permissions: string;
  /**
   * The permission bits alone, for editing. Null on a Windows local listing,
   * where there is no POSIX mode to set, and for `..`.
   */
  mode: number | null;
  /** Numeric owner and group; null where the listing has none, as with mode. */
  uid: number | null;
  gid: number | null;
  /** `user:group`, names where the server's passwd knows them, else numbers. Empty when unknown. */
  owner: string;
  kind: string;
  /**
   * Decided by the backend, not from the name. A leading dot is a naming
   * convention; on Windows hidden is a file attribute, which is the only thing
   * marking desktop.ini.
   */
  hidden: boolean;
  /**
   * A symbolic link. Every other field describes its target, which is followed
   * so a link to a folder is a folder rather than a zero-byte file.
   */
  symlink: boolean;
}

/** One upload by the edit-in-place watcher, successful or not. */
export interface EditEvent {
  remote_path: string;
  name: string;
  error: string | null;
}

/** Per-collection tallies, shared by every export and import result. */
export interface TransferCounts {
  servers: number;
  identities: number;
  keys: number;
  port_forwardings: number;
  codeprints: number;
  custom_themes: number;
  known_hosts: number;
}

/** Singular and plural for each thing an export or import counts. */
const COUNT_NAMES: Record<keyof TransferCounts, [string, string]> = {
  servers: ['host', 'hosts'],
  identities: ['identity', 'identities'],
  keys: ['key', 'keys'],
  port_forwardings: ['tunnel', 'tunnels'],
  codeprints: ['codeprint', 'codeprints'],
  custom_themes: ['theme', 'themes'],
  known_hosts: ['known host', 'known hosts'],
};

/**
 * "3 hosts, 1 identity and 2 keys", from whatever the counts hold.
 *
 * The export modal hand-wrote all seven clauses into one sentence, each with
 * its own pluralisation. Adding an eighth collection on the Rust side would
 * have left it silently unmentioned, which is the failure worth avoiding: the
 * sentence exists to tell the user what went into the file.
 *
 * Zeroes are left out. A list of things that did not happen is noise, and if
 * everything is zero the caller wants to say so in its own words.
 */
export function describeCounts(counts: TransferCounts): string {
  const parts = (Object.keys(COUNT_NAMES) as (keyof TransferCounts)[])
    .filter((k) => counts[k] > 0)
    .map((k) => `${counts[k]} ${COUNT_NAMES[k][counts[k] === 1 ? 0 : 1]}`);
  if (parts.length === 0) return 'nothing';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

export interface ExportResult {
  path: string;
  bytes: number;
  counts: TransferCounts;
  secrets_included: boolean;
}

/** What an import would do, worked out before anything is changed. */
export interface MergePlan {
  created: number;
  app_version: string;
  secrets_included: boolean;
  incoming: TransferCounts;
  duplicates: TransferCounts;
  missing_key_paths: string[];
  host_key_conflicts: string[];
  has_settings: boolean;
}

export interface ImportOptions {
  servers: boolean;
  identities: boolean;
  keys: boolean;
  port_forwardings: boolean;
  codeprints: boolean;
  custom_themes: boolean;
  settings: boolean;
  known_hosts: boolean;
}

export interface ImportReport {
  added: TransferCounts;
  skipped: TransferCounts;
  unresolved_refs: number;
  settings_replaced: boolean;
  host_key_conflicts: string[];
}
