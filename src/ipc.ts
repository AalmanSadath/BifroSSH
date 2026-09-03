/**
 * Every call into the Rust side, in one place and typed.
 *
 * The 97 `invoke` sites this replaced each spelled their own command name and
 * their own argument keys, in camelCase, to be matched against Rust's
 * snake_case by Tauri's own conversion at runtime. Nothing checked either
 * half: a misspelled key became a deserialize error the user saw as a failed
 * connect, and a command whose signature changed on the Rust side compiled
 * cleanly on this one.
 *
 * So the strings live here and nowhere else, wrapped in a function whose
 * parameters are the command's parameters. Renaming an argument in Rust now
 * breaks exactly one line, and `tsc` finds it.
 *
 * Grouped to mirror `src-tauri/src/commands/*.rs`, in the same order, so the
 * two files can be read side by side.
 */
import { invoke } from '@tauri-apps/api/core';
import type {
  AgentKeyInfo,
  AuthType,
  Codeprint,
  ConnectRequest,
  ExportResult,
  FileEntry,
  GeneratedKey,
  HostKeyDecision,
  Identity,
  IdentityInput,
  ImportOptions,
  ImportReport,
  JumpHopParams,
  KeyContent,
  KeyEntry,
  KeystoreStatus,
  KnownHostEntry,
  MergePlan,
  PortForwarding,
  QuickConnectRequest,
  Server,
  ServerInput,
  Settings,
  SshConfigImportResult,
  SshConfigScan,
  SystemAppearance,
  TransferSummary,
  VaultInitMode,
  VaultStatus,
} from './types';
import type { NamedTheme } from './styles/themes';

// ── servers ──────────────────────────────────────────────────────────────

export const listServers = () => invoke<Server[]>('list_servers');

/** An empty `id` creates; anything else updates in place. */
export const saveServer = (server: ServerInput, password: string | null) =>
  invoke<Server>('save_server', { server, password });

export const getServerPassword = (serverId: string) =>
  invoke<string>('get_server_password', { serverId });

export const deleteServer = (serverId: string) =>
  invoke<void>('delete_server', { serverId });

// ── keys ─────────────────────────────────────────────────────────────────

export const listKeys = () => invoke<KeyEntry[]>('list_keys');

export const importKeyFromPath = (
  name: string,
  path: string,
  passphrase: string | null,
  storeContent: boolean,
) => invoke<KeyEntry>('import_key_from_path', { name, path, passphrase, storeContent });

export const saveKeyFromContent = (
  name: string,
  content: string,
  passphrase: string | null,
) => invoke<KeyEntry>('save_key_from_content', { name, content, passphrase });

export const generateKey = (algorithm: string, passphrase: string | null) =>
  invoke<GeneratedKey>('generate_key', { algorithm, passphrase });

export const getKeyContent = (keyId: string) =>
  invoke<KeyContent>('get_key_content', { keyId });

export const updateKey = (
  keyId: string,
  name: string,
  content: string,
  passphrase: string | null,
) => invoke<void>('update_key', { keyId, name, content, passphrase });

export const deleteKey = (keyId: string) => invoke<void>('delete_key', { keyId });

/** Returns the key as OpenSSH PEM; the PPK itself is left alone. */
export const convertPpk = (content: string, passphrase: string | null) =>
  invoke<string>('convert_ppk', { content, passphrase });

// ── identities ───────────────────────────────────────────────────────────

export const listIdentities = () => invoke<Identity[]>('list_identities');

export const saveIdentity = (identity: IdentityInput, password: string | null) =>
  invoke<Identity>('save_identity', { identity, password });

export const deleteIdentity = (identityId: string) =>
  invoke<void>('delete_identity', { identityId });

export const getIdentityPassword = (identityId: string) =>
  invoke<string>('get_identity_password', { identityId });

// ── settings ─────────────────────────────────────────────────────────────

export const getSettings = () => invoke<Settings>('get_settings');

export const saveSettings = (settings: Settings) =>
  invoke<void>('save_settings', { settings });

export const listFonts = () => invoke<string[]>('list_fonts');

/** Never fails; a desktop that cannot be asked reports no preference. */
export const systemAppearance = () => invoke<SystemAppearance>('system_appearance');
/** 'linux' | 'windows' | 'macos' | whatever else Rust's env::consts::OS names. */
export const platform = () => invoke<string>('platform');
/** Where the vault, keystore and backups live. Differs by platform. */
export const dataDir = () => invoke<string>('data_dir');
/**
 * The clipboard as text, read by the backend.
 *
 * Only for the paste routes the webview refuses: `navigator.clipboard.readText`
 * needs a user activation and a right click is not one.
 */
export const clipboardReadText = () => invoke<string>('clipboard_read_text');

// ── ssh_config import ────────────────────────────────────────────────────

export const scanSshConfig = () => invoke<SshConfigScan>('scan_ssh_config');

export const importSshConfigHosts = (aliases: string[]) =>
  invoke<SshConfigImportResult>('import_ssh_config_hosts', { aliases });

// ── export and import ────────────────────────────────────────────────────

export const defaultExportDir = () => invoke<string>('default_export_dir');

export const exportData = (
  path: string,
  passphrase: string,
  includeSecrets: boolean,
  overwrite: boolean,
) => invoke<ExportResult>('export_data', { path, passphrase, includeSecrets, overwrite });

/** Reads the archive and reports what an import would do, changing nothing. */
export const previewImport = (path: string, passphrase: string) =>
  invoke<MergePlan>('preview_import', { path, passphrase });

export const importData = (path: string, passphrase: string, options: ImportOptions) =>
  invoke<ImportReport>('import_data', { path, passphrase, options });

// ── collections ──────────────────────────────────────────────────────────

export const getPortForwardings = () => invoke<PortForwarding[]>('get_port_forwardings');

export const savePortForwardings = (items: PortForwarding[]) =>
  invoke<void>('save_port_forwardings', { items });

export const getCodeprints = () => invoke<Codeprint[]>('get_codeprints');

export const saveCodeprints = (items: Codeprint[]) =>
  invoke<void>('save_codeprints', { items });

export const getCustomThemes = () =>
  invoke<Record<string, NamedTheme>>('get_custom_themes');

export const saveCustomThemes = (items: Record<string, NamedTheme>) =>
  invoke<void>('save_custom_themes', { items });

// ── vault and keystore ───────────────────────────────────────────────────

export const vaultStatus = () => invoke<VaultStatus>('vault_status');

export const initializeVault = (mode: VaultInitMode, passphrase: string) =>
  invoke<void>('initialize_vault', { mode, passphrase });

export const generatePassphrase = () => invoke<string>('generate_passphrase');

export const unlockVault = (passphrase: string) =>
  invoke<void>('unlock_vault', { passphrase });

export const keystoreStatus = () => invoke<KeystoreStatus>('keystore_status');

export const setMasterPassphrase = (passphrase: string, alwaysAsk: boolean) =>
  invoke<void>('set_master_passphrase', { passphrase, alwaysAsk });

export const setAlwaysAsk = (alwaysAsk: boolean) =>
  invoke<void>('set_always_ask', { alwaysAsk });

export const removeMasterPassphrase = (passphrase: string) =>
  invoke<void>('remove_master_passphrase', { passphrase });

// ── host keys and prompts ────────────────────────────────────────────────

export const respondHostKey = (requestId: string, decision: HostKeyDecision) =>
  invoke<void>('respond_host_key', { requestId, decision });

/** `null` responses cancels the prompt, which fails the connection. */
export const respondAuthPrompt = (requestId: string, responses: string[] | null) =>
  invoke<void>('respond_auth_prompt', { requestId, responses });

export const listKnownHosts = () => invoke<KnownHostEntry[]>('list_known_hosts');

export const listAgentKeys = () => invoke<AgentKeyInfo[]>('list_agent_keys');

export const forgetKnownHost = (host: string, port: number) =>
  invoke<void>('forget_known_host', { host, port });

// ── os detection ─────────────────────────────────────────────────────────

/** Returns `UNKNOWN_OS` rather than failing when the host cannot say. */
export const detectServerOs = (
  serverId: string,
  username: string,
  authType: AuthType,
  authValue: string,
  jumps: JumpHopParams[],
) => invoke<string>('detect_server_os', { serverId, username, authType, authValue, jumps });

// ── ssh sessions ─────────────────────────────────────────────────────────

/** Returns the session id the other ssh commands are addressed with. */
export const sshConnect = (request: ConnectRequest) =>
  invoke<string>('ssh_connect', { request });

export const sshConnectQuick = (request: QuickConnectRequest) =>
  invoke<string>('ssh_connect_quick', { request });

/** Bytes as a plain array: a Uint8Array does not survive the bridge intact. */
export const sshSendInput = (sessionId: string, data: number[]) =>
  invoke<void>('ssh_send_input', { sessionId, data });

export const sshResize = (sessionId: string, cols: number, rows: number) =>
  invoke<void>('ssh_resize', { sessionId, cols, rows });

/** Returns whatever the session buffered while no terminal was attached. */
export const sshAttach = (sessionId: string) =>
  invoke<string>('ssh_attach', { sessionId });

export const sshDisconnect = (sessionId: string) =>
  invoke<void>('ssh_disconnect', { sessionId });

// ── sftp ─────────────────────────────────────────────────────────────────

export const sftpLocalHome = () => invoke<string>('sftp_local_home');

export const sftpListLocal = (path: string) =>
  invoke<FileEntry[]>('sftp_list_local', { path });

export const sftpConnectRemote = (
  serverId: string,
  username: string,
  authType: AuthType,
  authValue: string,
  connectId: string | null,
  jumps: JumpHopParams[],
) => invoke<string>('sftp_connect_remote', {
  serverId, username, authType, authValue, connectId, jumps,
});

export const sftpGetHome = (sessionId: string) =>
  invoke<string>('sftp_get_home', { sessionId });

export const sftpListRemote = (sessionId: string, path: string) =>
  invoke<FileEntry[]>('sftp_list_remote', { sessionId, path });

export const sftpDisconnectRemote = (sessionId: string) =>
  invoke<void>('sftp_disconnect_remote', { sessionId });

export const sftpUpload = (sessionId: string, localPath: string, remoteDir: string) =>
  invoke<TransferSummary>('sftp_upload', { sessionId, localPath, remoteDir });

export const sftpDownload = (sessionId: string, remotePath: string, localDir: string) =>
  invoke<TransferSummary>('sftp_download', { sessionId, remotePath, localDir });

export const sftpCopyRemoteToRemote = (
  srcSessionId: string,
  srcPath: string,
  dstSessionId: string,
  dstDir: string,
) => invoke<TransferSummary>('sftp_copy_remote_to_remote', {
  srcSessionId, srcPath, dstSessionId, dstDir,
});

/** Stops the one transfer in flight; there is never more than one. */
export const sftpCancelTransfer = () => invoke<void>('sftp_cancel_transfer');

export const sftpCreateLocalDir = (path: string) =>
  invoke<void>('sftp_create_local_dir', { path });

export const sftpMkdir = (sessionId: string, path: string) =>
  invoke<void>('sftp_mkdir', { sessionId, path });

export const sftpDeleteLocal = (path: string) =>
  invoke<void>('sftp_delete_local', { path });

export const sftpRenameLocal = (oldPath: string, newPath: string) =>
  invoke<void>('sftp_rename_local', { oldPath, newPath });

export const sftpDeleteRemote = (sessionId: string, path: string, isDir: boolean) =>
  invoke<void>('sftp_delete_remote', { sessionId, path, isDir });

export const sftpRenameRemote = (sessionId: string, oldPath: string, newPath: string) =>
  invoke<void>('sftp_rename_remote', { sessionId, oldPath, newPath });

// ── tunnels ──────────────────────────────────────────────────────────────

/**
 * Which ports are required depends on `pfType`, and the backend says so rather
 * than guessing: local and dynamic need `localPort`, local and remote need a
 * destination, remote needs `remotePort`.
 */
export const tunnelStart = (args: {
  pfId: string;
  pfType: PortForwarding['type'];
  bindAddress: string;
  localPort: number | null;
  remotePort: number | null;
  destHost: string | null;
  destPort: number | null;
  serverId: string;
  username: string;
  authType: AuthType;
  authValue: string;
  jumps: JumpHopParams[];
}) => invoke<void>('tunnel_start', args);

export const tunnelStop = (pfId: string) => invoke<void>('tunnel_stop', { pfId });
