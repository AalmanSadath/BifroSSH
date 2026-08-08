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

/**
 * One jump host as the backend expects it. The chain is walked and its
 * credentials resolved on this side; a key here is still just an id, and the
 * backend goes to the keychain for the material.
 */
export interface JumpHopParams {
  host: string;
  port: number;
  username: string;
  auth_type: string;
  auth_value: string;
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

export interface Settings {
  theme: string;
  font_size: number;
  font_family: string;
  cursor_style: string;
  cursor_blink: boolean;
  app_theme: 'dark' | 'light' | 'amoled';
  connection_timeout_secs: number;
  show_hover_hints: boolean;
  sftp_inactivity_timeout_secs: number;
  host_key_policy: HostKeyPolicy;
  /** Seconds between keepalives on terminal and tunnel connections; 0 is off. */
  keepalive_interval_secs: number;
}

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

/** Result of a recursive SFTP transfer. */
export interface TransferSummary {
  files: number;
  directories: number;
  /** Symlinks are not copied; following them risks an unbounded loop. */
  skipped_symlinks: number;
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

export interface ConnectRequest {
  server_id: string;
  username: string;
  auth_type: 'password' | 'key';
  auth_value: string;
  cols: number;
  rows: number;
}

/** A local file or directory, as `sftp_list_local` reports it. */
export interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  modified: number | null;
  permissions: string;
  kind: string;
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
