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
}

/** Payload of the `sftp-progress` event, emitted as bytes move. */
export interface TransferProgress {
  file_name: string;
  transferred: number;
  total: number;
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
  /** True when the user stopped it; `files` then counts what arrived. */
  cancelled: boolean;
}

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
  /** ProxyJump is not supported yet; recorded so the UI can warn. */
  proxy_jump: string | null;
}

export interface SshConfigScan {
  hosts: SshConfigHost[];
  /** Include directives are not followed, so an import may be partial. */
  has_includes: boolean;
}

export interface SshConfigImportResult {
  imported: number;
  skipped_existing: number;
  keys_linked: number;
  jumps_linked: number;
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

export interface SessionTab {
  session_id: string;
  server_name: string;
  server_id: string;
  status: 'connecting' | 'connected' | 'error';
  connect_id?: string;
  error?: string;
  logs?: LogEntry[];
  quick_info?: { host: string; port: number; username: string };
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
  kind: string;
  /**
   * Decided by the backend, not from the name. A leading dot is a naming
   * convention; on Windows hidden is a file attribute, which is the only thing
   * marking desktop.ini.
   */
  hidden: boolean;
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
