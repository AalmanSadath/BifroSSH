export interface Server {
  id: string;
  name: string;
  host: string;
  port: number;
  identity_id: string | null;
  theme: string | null;
}

export interface Identity {
  id: string;
  name: string;
  username: string;
  key_id: string;
}

export interface KeyEntry {
  id: string;
  name: string;
  key_path: string | null;
  encrypted_key: string | null;
  encrypted_passphrase: string | null;
}

export interface Settings {
  theme: string;
  font_size: number;
  font_family: string;
  cursor_style: string;
  cursor_blink: boolean;
}

export interface SessionTab {
  session_id: string;
  server_name: string;
  server_id: string;
}

export interface ConnectRequest {
  server_id: string;
  username: string;
  auth_type: 'password' | 'key';
  auth_value: string;
  cols: number;
  rows: number;
}
