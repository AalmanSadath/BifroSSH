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
}

/** 'keyboard-interactive' selects PAM/2FA challenge-response. */
export type AuthKind = 'keyboard-interactive';

export interface Identity {
  id: string;
  name: string;
  username: string;
  key_id: string | null;
  encrypted_password: string | null;
  auth_kind: AuthKind | null;
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
