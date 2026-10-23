import { DEFAULT_HIGHLIGHT_RULES } from '../highlight';
import type { Settings } from '../types';
import { cachedAppTheme } from './themeCache';

/**
 * How long a retry waits, and how long it may grow to. Shared by the
 * tunnel retry and the terminal one, which are the same idea twice: come
 * back quickly at first, then stop hammering something that is down.
 */
export const RETRY_FIRST_MS = 5_000;
export const RETRY_MAX_MS = 60_000;

export const DEFAULT_SETTINGS: Settings = {
  theme: 'bifrossh-dark',
  font_size: 14,
  font_family: 'monospace',
  cursor_style: 'block',
  cursor_blink: true,
  app_theme: cachedAppTheme(),
  connection_timeout_secs: 60,
  show_hover_hints: true,
  sftp_inactivity_timeout_secs: 300,
  host_key_policy: 'ask',
  keepalive_interval_secs: 30,
  auto_lock_minutes: 0,
  lock_on_suspend: true,
  scrollback_lines: 10000,
  session_log_dir: null,
  recording_dir: null,
  check_for_updates: true,
  last_update_check: 0,
  auto_reconnect: true,
  auto_reconnect_attempts: 5,
  restore_tabs: true,
  verify_transfers: false,
  shortcuts: {},
  highlight_enabled: true,
  highlight_rules: DEFAULT_HIGHLIGHT_RULES,
  autosuggest: true,
  monitor_bar: false,
  local_shell: '',
  inline_images: true,
  accent_color: null,
  keep_awake: false,
  background_lock_minutes: null,
  volume_keys_zoom: true,
};
