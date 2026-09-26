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
  ClientImportResult,
  ClientScan,
  Codeprint,
  Conflict,
  ConnectRequest,
  ExportResult,
  FileEntry,
  GeneratedKey,
  HostKeyDecision,
  HostProbe,
  HostSample,
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
  OpenTab,
  PortForwarding,
  QuickConnectRequest,
  Server,
  SftpBookmark,
  ServerInput,
  Settings,
  SshConfigImportResult,
  SshConfigScan,
  SystemAppearance,
  TransferKind,
  TransferSummary,
  TreeDiff,
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

/** Several hosts, one write. */
export const deleteServers = (serverIds: string[]) =>
  invoke<void>('delete_servers', { serverIds });

/** Several hosts into one group, or none for null; answers with every host. */
export const setServersGroup = (serverIds: string[], group: string | null) =>
  invoke<Server[]>('set_servers_group', { serverIds, group });

/** A tag onto several hosts, or off them; answers with every host. */
export const addServersTag = (serverIds: string[], tag: string) =>
  invoke<Server[]>('add_servers_tag', { serverIds, tag });
export const removeServersTag = (serverIds: string[], tag: string) =>
  invoke<Server[]>('remove_servers_tag', { serverIds, tag });

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

export const scanClientExport = (path: string) =>
  invoke<ClientScan>('scan_client_export', { path });

/**
 * Imports the rows at these positions in the file at `path`.
 *
 * `total` is how many hosts the scan found, sent back so the backend can
 * refuse a file that changed under the dialog rather than importing whichever
 * lines now sit at those positions.
 */
export const importClientHosts = (
  path: string,
  picked: number[],
  total: number,
  withPasswords: boolean,
) =>
  invoke<ClientImportResult>('import_client_hosts', {
    path,
    picked,
    total,
    withPasswords,
  });

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

export const getSftpBookmarks = () => invoke<SftpBookmark[]>('get_sftp_bookmarks');

export const saveSftpBookmarks = (items: SftpBookmark[]) =>
  invoke<void>('save_sftp_bookmarks', { items });

export const probeHost = (host: string, port: number, timeoutSecs: number) =>
  invoke<HostProbe>('probe_host', { host, port, timeoutSecs });

export const sftpCompareTrees = (
  transferId: string,
  leftSessionId: string | null,
  leftPath: string,
  rightSessionId: string | null,
  rightPath: string,
) => invoke<TreeDiff>('sftp_compare_trees', { transferId, leftSessionId, leftPath, rightSessionId, rightPath });

/**
 * Writes text to a path the user chose. Without `overwrite` a file that is
 * already there is an error rather than something quietly replaced.
 */
export const writeTextFile = (path: string, contents: string, overwrite: boolean) =>
  invoke<void>('write_text_file', { path, contents, overwrite });

export const getOpenTabs = () => invoke<OpenTab[]>('get_open_tabs');

export const saveOpenTabs = (items: OpenTab[]) => invoke<void>('save_open_tabs', { items });

export const getCommandHistory = (serverId: string) =>
  invoke<string[]>('get_command_history', { serverId });

/** Commands run on a host, oldest first. */
export const recordCommands = (serverId: string, commands: string[]) =>
  invoke<void>('record_commands', { serverId, commands });

/** One host's history, or every host's for null. */
export const clearCommandHistory = (serverId: string | null) =>
  invoke<void>('clear_command_history', { serverId });

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
/**
 * Closes the vault: the key is dropped and every command fails until the
 * passphrase is entered again. Refused while no passphrase is set, since the
 * keyring would reopen it without asking.
 */
export const lockVault = () => invoke<void>('lock_vault');

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

/** One reading of the host a terminal is on, taken over its own connection. */
export const sshHostStats = (sessionId: string) =>
  invoke<HostSample>('ssh_host_stats', { sessionId });

/** Starts (returning the file's path) or stops logging a session's output. */
export const sshSetLog = (sessionId: string, label: string, on: boolean) =>
  invoke<string | null>('ssh_set_log', { sessionId, label, on });

/** The folder session logs are written to, as configured or by default. */
export const sessionLogDir = () => invoke<string>('session_log_dir');

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

/** Whether the session still answers. Asked only after a listing has failed. */
export const sftpProbeRemote = (sessionId: string) =>
  invoke<boolean>('sftp_probe_remote', { sessionId });
export const sftpDisconnectRemote = (sessionId: string) =>
  invoke<void>('sftp_disconnect_remote', { sessionId });

/*
 * Each transfer carries an id the panel minted: progress events name it,
 * and a cancel is sent to it.
 */
export const sftpUpload = (transferId: string, sessionId: string, localPath: string, remoteDir: string, conflict: Conflict) =>
  invoke<TransferSummary>('sftp_upload', { transferId, sessionId, localPath, remoteDir, conflict });

export const sftpDownload = (transferId: string, sessionId: string, remotePath: string, localDir: string, conflict: Conflict) =>
  invoke<TransferSummary>('sftp_download', { transferId, sessionId, remotePath, localDir, conflict });

export const sftpCopyRemoteToRemote = (
  transferId: string,
  srcSessionId: string,
  srcPath: string,
  dstSessionId: string,
  dstDir: string,
  conflict: Conflict,
) => invoke<TransferSummary>('sftp_copy_remote_to_remote', {
  transferId, srcSessionId, srcPath, dstSessionId, dstDir, conflict,
});

/**
 * The files, relative to the item, that a transfer would write over.
 * Asked before the transfer so the user can be asked before anything is.
 */
/**
 * Copies named files of a finished transfer again, over what is there.
 *
 * `rels` come straight out of a summary's `mismatched`, relative to the
 * transfer root, and `destRoot` is that summary's `landed`.
 */
export const sftpRecopy = (
  transferId: string,
  kind: TransferKind,
  srcSessionId: string | null,
  srcPath: string,
  dstSessionId: string | null,
  destRoot: string,
  rels: string[],
) => invoke<TransferSummary>('sftp_recopy', { transferId, kind, srcSessionId, srcPath, dstSessionId, destRoot, rels });

export const sftpConflicts = (
  kind: TransferKind,
  srcSessionId: string | null,
  srcPath: string,
  dstSessionId: string | null,
  dstDir: string,
) => invoke<string[]>('sftp_conflicts', { kind, srcSessionId, srcPath, dstSessionId, dstDir });

/**
 * A remote directory downloaded as one compressed stream and unpacked
 * here, which for a tree of small files is far quicker than a file at a
 * time. Reports progress and cancels like any other transfer.
 */
export const sftpDownloadArchive = (transferId: string, sessionId: string, remotePath: string, localDir: string, intoName: string | null = null) =>
  invoke<TransferSummary>('sftp_download_archive', { transferId, sessionId, remotePath, localDir, intoName });

/** The same upwards: this machine tars, the server unpacks. */
export const sftpUploadArchive = (transferId: string, sessionId: string, localPath: string, remoteDir: string, intoName: string | null = null) =>
  invoke<TransferSummary>('sftp_upload_archive', { transferId, sessionId, localPath, remoteDir, intoName });

/** Between two servers, without the bytes touching this disk. */
export const sftpCopyArchive = (
  transferId: string,
  srcSessionId: string,
  srcPath: string,
  dstSessionId: string,
  dstDir: string,
  intoName: string | null = null,
) => invoke<TransferSummary>('sftp_copy_archive', { transferId, srcSessionId, srcPath, dstSessionId, dstDir, intoName });

/** Stops the named transfer at its next chunk; an id not running is ignored. */
export const sftpCancelTransfer = (transferId: string) => invoke<void>('sftp_cancel_transfer', { transferId });

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

export const sftpOpenLocal = (path: string) =>
  invoke<void>('sftp_open_local', { path });

/**
 * Downloads to a temp copy, opens it with the default application, and
 * uploads it back after every save until the session ends. Progress is
 * reported on `sftp-edit:{sessionId}` as an `EditEvent`.
 */
export const sftpOpenRemote = (sessionId: string, path: string) =>
  invoke<void>('sftp_open_remote', { sessionId, path });

export const sftpSetModeLocal = (path: string, mode: number) =>
  invoke<void>('sftp_set_mode_local', { path, mode });

export const sftpSetModeRemote = (sessionId: string, path: string, mode: number) =>
  invoke<void>('sftp_set_mode_remote', { sessionId, path, mode });

/** chown by name; a number is taken as itself. */
export const sftpSetOwnerLocal = (path: string, user: string, group: string) =>
  invoke<void>('sftp_set_owner_local', { path, user, group });

export const sftpSetOwnerRemote = (sessionId: string, path: string, user: string, group: string) =>
  invoke<void>('sftp_set_owner_remote', { sessionId, path, user, group });

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
