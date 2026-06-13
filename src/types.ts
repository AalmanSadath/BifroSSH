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
}

export interface Identity {
  id: string;
  name: string;
  username: string;
  key_id: string | null;
  encrypted_password: string | null;
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

export interface ConnectRequest {
  server_id: string;
  username: string;
  auth_type: 'password' | 'key';
  auth_value: string;
  cols: number;
  rows: number;
}
