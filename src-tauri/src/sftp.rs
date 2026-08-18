use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::SystemTime;

use anyhow::Result;
use russh::*;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tauri::Emitter;
use tokio::sync::Mutex;
use tokio::time::Duration;

use crate::hostkeys::{ConnectSecurity, HostKeyVerifier, VerifyingHandler};
use crate::jump::JumpHop;
use crate::ssh::{AuthContext, SshAuth};

const CHUNK: usize = 128 * 1024; // 128 KB

#[derive(Serialize, Clone)]
pub struct TransferProgress {
    pub file_name: String,
    pub transferred: u64,
    pub total: u64,
    /// 1-based position of this file within the batch. Always 1/1 for a single
    /// file, so the UI can show "3 of 12" only when it means something.
    pub file_index: u32,
    pub file_count: u32,
}

/// Outcome of a recursive transfer, so the caller can report what was skipped
/// rather than silently copying less than the user asked for.
#[derive(Serialize, Clone, Default)]
pub struct TransferSummary {
    pub files: u32,
    pub directories: u32,
    /// Symlinks are not copied. Following them risks a loop that would recurse
    /// until the disk fills, and recreating them is not something SFTP does
    /// portably.
    pub skipped_symlinks: u32,
    /// True when the user stopped it. The files already copied are left where
    /// they are; only the one in flight is removed. `files` counts what
    /// actually arrived, so a cancelled batch reports fewer than were asked for.
    pub cancelled: bool,
}

/// Whether a file ran to the end or was stopped part way.
#[derive(PartialEq)]
enum Step {
    Finished,
    Cancelled,
}

/// One entry in a directory walk, relative to the transfer root.
struct TreeItem {
    rel: String,
    is_dir: bool,
}

/// Guards against a pathological or hostile tree. Deeper than any real layout.
const MAX_DEPTH: usize = 64;

fn join_remote(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{}", name)
    } else {
        format!("{}/{}", dir.trim_end_matches('/'), name)
    }
}

#[derive(Serialize, Clone, Debug)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<u64>,
    pub permissions: String,
    pub kind: String,
}

pub struct SftpClientState {
    sessions: Mutex<HashMap<String, Arc<Mutex<SftpSession>>>>,
    /// Raised to stop the transfer in flight.
    ///
    /// One flag rather than one per transfer because the panel runs a single
    /// transfer at a time: the drop targets are suppressed while one is
    /// running, so there is never a second to tell apart from the first.
    cancel: Arc<AtomicBool>,
}

impl SftpClientState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Asks the transfer in flight to stop at the next chunk boundary.
    pub fn request_cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }

    /// Clears any cancellation left over from a previous transfer and hands
    /// back the flag to watch. Called once at the top of each transfer, so a
    /// cancel that arrived after the last one finished cannot kill the next.
    fn begin_transfer(&self) -> Arc<AtomicBool> {
        self.cancel.store(false, Ordering::Relaxed);
        Arc::clone(&self.cancel)
    }
}

fn format_mode(mode: u32) -> String {
    let bits = [
        (0o400, 'r'), (0o200, 'w'), (0o100, 'x'),
        (0o040, 'r'), (0o020, 'w'), (0o010, 'x'),
        (0o004, 'r'), (0o002, 'w'), (0o001, 'x'),
    ];
    let prefix = if mode & 0o040000 != 0 { 'd' } else { '-' };
    let s: String = bits.iter().map(|(m, c)| if mode & m != 0 { *c } else { '-' }).collect();
    format!("{}{}", prefix, s)
}

fn file_kind(name: &str, is_dir: bool) -> String {
    if is_dir { return "folder".into(); }
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "rs" => "Rust Source",
        "ts" | "tsx" => "TypeScript",
        "js" | "jsx" => "JavaScript",
        "py" => "Python Script",
        "sh" | "bash" | "zsh" => "Shell Script",
        "txt" | "md" => "Text",
        "pdf" => "PDF",
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" => "Image",
        "zip" | "tar" | "gz" | "bz2" | "xz" | "7z" => "Archive",
        "json" => "JSON",
        "toml" | "yaml" | "yml" => "Config",
        "c" | "h" => "C Source",
        "cpp" | "hpp" => "C++ Source",
        "go" => "Go Source",
        "html" | "htm" => "HTML",
        "css" | "scss" => "Stylesheet",
        _ => "Document",
    }.into()
}

pub fn get_local_home() -> String {
    dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("/"))
        .to_string_lossy()
        .into_owned()
}

pub fn list_local(path: &str) -> Result<Vec<FileEntry>, String> {
    let path_obj = if path.is_empty() || path == "~" {
        dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("/"))
    } else {
        std::path::PathBuf::from(path)
    };

    let path_str = path_obj.to_string_lossy().into_owned();
    let read = fs::read_dir(&path_obj).map_err(|e| format!("{}: {}", path_str, e))?;

    let mut entries: Vec<FileEntry> = Vec::new();

    if let Some(parent) = path_obj.parent() {
        let parent_str = parent.to_string_lossy().into_owned();
        if parent_str != path_str {
            entries.push(FileEntry {
                name: "..".into(),
                path: parent_str,
                is_dir: true,
                size: 0,
                modified: None,
                permissions: String::new(),
                kind: "folder".into(),
            });
        }
    }

    for e in read {
        let Ok(e) = e else { continue; };
        let Ok(meta) = e.metadata() else { continue; };
        let name = e.file_name().to_string_lossy().into_owned();
        let is_dir = meta.is_dir();
        let size = if is_dir { 0 } else { meta.len() };
        let modified = meta.modified().ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());

        #[cfg(unix)]
        let permissions = {
            use std::os::unix::fs::PermissionsExt;
            format_mode(meta.permissions().mode())
        };
        #[cfg(not(unix))]
        let permissions = String::new();

        let kind = file_kind(&name, is_dir);
        let file_path = path_obj.join(&name).to_string_lossy().into_owned();

        entries.push(FileEntry { name, path: file_path, is_dir, size, modified, permissions, kind });
    }

    if entries.len() > 1 {
        entries[1..].sort_by(|a, b| match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
    }

    Ok(entries)
}

// Threaded straight through from the command layer. Collapsing these into a
// params struct belongs with the wider connect-path dedup, not here.
#[allow(clippy::too_many_arguments)]
pub async fn connect_sftp(
    sftp_state: &SftpClientState,
    session_id: &str,
    host: &str,
    port: u16,
    username: &str,
    auth: SshAuth,
    inactivity_timeout_secs: u32,
    sec: ConnectSecurity,
    jumps: Vec<JumpHop>,
) -> Result<(), String> {
    // The countdown pauses while a host key or auth prompt is on screen.
    let waiting = Arc::clone(&sec.waiting);
    crate::commands::timeout_pausable(
        connect_sftp_inner(sftp_state, session_id, host, port, username, auth, inactivity_timeout_secs, sec, jumps),
        30,
        waiting,
    )
    .await
    .map_err(|_| "Connection timed out after 30 seconds".to_string())?
}

// Threaded straight through from the command layer. Collapsing these into a
// params struct belongs with the wider connect-path dedup, not here.
#[allow(clippy::too_many_arguments)]
async fn connect_sftp_inner(
    sftp_state: &SftpClientState,
    session_id: &str,
    host: &str,
    port: u16,
    username: &str,
    auth: SshAuth,
    inactivity_timeout_secs: u32,
    sec: ConnectSecurity,
    jumps: Vec<JumpHop>,
) -> Result<(), String> {
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(inactivity_timeout_secs as u64)),
        ..Default::default()
    });

    sec.log("auth", &format!("Starting SFTP connection to \"{}\" port \"{}\"", host, port));

    // Resolution, the TCP connect, and every jump host in between.
    let transport = crate::jump::open_transport(&jumps, host, port, &sec, None)
        .await
        .map_err(|e| {
            let message = e.to_string();
            sec.log("error", &message);
            message
        })?;

    let verifier = HostKeyVerifier::new(sec.clone(), host, port, Some(username.to_string()));
    let mut handle = client::connect_stream(config, transport, VerifyingHandler { v: verifier.clone() })
        .await
        .map_err(|e| {
            let message = crate::ssh::host_key_error(&verifier, e).to_string();
            sec.log("error", &message);
            message
        })?;

    sec.log("auth", &format!("Authenticating to \"{}\":\"{}\" as \"{}\"", host, port, username));
    crate::ssh::authenticate(&mut handle, &auth, &AuthContext::new(sec.clone(), username).with_host(host))
        .await
        .map_err(|e| {
            sec.log("error", &e.to_string());
            e.to_string()
        })?;
    sec.log("auth", "Authentication succeeded");

    sec.log("network", "Opening session channel...");
    let channel = handle.channel_open_session().await.map_err(|e| e.to_string())?;

    sec.log("network", "Requesting SFTP subsystem...");
    channel.request_subsystem(true, "sftp").await.map_err(|e| {
        sec.log("error", &format!("SFTP subsystem request failed: {}", e));
        e.to_string()
    })?;

    let sftp = SftpSession::new(channel.into_stream()).await.map_err(|e| {
        sec.log("error", &format!("SFTP session failed to start: {}", e));
        e.to_string()
    })?;
    sec.log("auth", "SFTP ready");

    sftp_state.sessions.lock().await
        .insert(session_id.to_string(), Arc::new(Mutex::new(sftp)));

    // handle intentionally dropped; channel stream keeps connection alive
    drop(handle);

    Ok(())
}

pub async fn get_remote_home(sftp_state: &SftpClientState, session_id: &str) -> Result<String, String> {
    let sftp_arc = get_session(sftp_state, session_id).await?;
    let sftp = sftp_arc.lock().await;
    sftp.canonicalize(".").await.map_err(|e| e.to_string())
}

pub async fn list_remote(
    sftp_state: &SftpClientState,
    session_id: &str,
    path: &str,
) -> Result<Vec<FileEntry>, String> {
    let sftp_arc = get_session(sftp_state, session_id).await?;
    let sftp = sftp_arc.lock().await;

    let dir_entries = sftp.read_dir(path).await.map_err(|e| e.to_string())?;

    let mut entries: Vec<FileEntry> = Vec::new();

    if path != "/" {
        let parent = Path::new(path).parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| "/".to_string());
        entries.push(FileEntry {
            name: "..".into(),
            path: parent,
            is_dir: true,
            size: 0,
            modified: None,
            permissions: String::new(),
            kind: "folder".into(),
        });
    }

    for entry in dir_entries {
        let name = entry.file_name();
        if name == "." || name == ".." { continue; }
        let meta = entry.metadata();
        let is_dir = meta.is_dir();
        let size = meta.len();
        let modified = meta.modified().ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());
        let permissions = String::new();
        let kind = file_kind(&name, is_dir);
        let file_path = if path == "/" { format!("/{}", name) }
            else { format!("{}/{}", path.trim_end_matches('/'), name) };

        entries.push(FileEntry { name, path: file_path, is_dir, size, modified, permissions, kind });
    }

    if entries.len() > 1 {
        entries[1..].sort_by(|a, b| match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
    }

    Ok(entries)
}

/// Walks a local directory tree, yielding paths relative to `root`.
///
/// A directory is always recorded before any of its descendants, which callers
/// rely on to create parents first and to delete children first.
///
/// Symlinks are recorded as skipped rather than followed: a link pointing at an
/// ancestor would otherwise recurse until the disk fills.
fn collect_local_tree(root: &Path) -> Result<(Vec<TreeItem>, u32), String> {
    let mut items = Vec::new();
    let mut skipped = 0u32;
    let mut queue: Vec<(std::path::PathBuf, String, usize)> =
        vec![(root.to_path_buf(), String::new(), 0)];

    while let Some((dir, rel, depth)) = queue.pop() {
        if depth >= MAX_DEPTH {
            return Err(format!("Directory nesting deeper than {} levels", MAX_DEPTH));
        }
        let entries = fs::read_dir(&dir).map_err(|e| format!("{}: {}", dir.display(), e))?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let child_rel = if rel.is_empty() { name.clone() } else { format!("{}/{}", rel, name) };

            // symlink_metadata so a link is seen as a link, not its target.
            let meta = entry.metadata().map_err(|e| e.to_string())?;
            let link = fs::symlink_metadata(entry.path())
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false);

            if link {
                skipped += 1;
            } else if meta.is_dir() {
                items.push(TreeItem { rel: child_rel.clone(), is_dir: true });
                queue.push((entry.path(), child_rel, depth + 1));
            } else if meta.is_file() {
                items.push(TreeItem { rel: child_rel, is_dir: false });
            }
        }
    }
    Ok((items, skipped))
}

/// Remote equivalent of `collect_local_tree`.
async fn collect_remote_tree(
    sftp_arc: &Arc<Mutex<SftpSession>>,
    root: &str,
) -> Result<(Vec<TreeItem>, u32), String> {
    let mut items = Vec::new();
    let mut skipped = 0u32;
    let mut queue: Vec<(String, String, usize)> = vec![(root.to_string(), String::new(), 0)];

    while let Some((dir, rel, depth)) = queue.pop() {
        if depth >= MAX_DEPTH {
            return Err(format!("Directory nesting deeper than {} levels", MAX_DEPTH));
        }
        let read = {
            let sftp = sftp_arc.lock().await;
            sftp.read_dir(&dir).await.map_err(|e| format!("{}: {}", dir, e))?
        };
        for entry in read {
            let name = entry.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let child_rel = if rel.is_empty() { name.clone() } else { format!("{}/{}", rel, name) };
            let file_type = entry.file_type();

            if file_type.is_symlink() {
                skipped += 1;
            } else if file_type.is_dir() {
                items.push(TreeItem { rel: child_rel.clone(), is_dir: true });
                queue.push((join_remote(&dir, &name), child_rel, depth + 1));
            } else {
                items.push(TreeItem { rel: child_rel, is_dir: false });
            }
        }
    }
    Ok((items, skipped))
}

/// Creates a remote directory, treating "already exists" as success.
async fn ensure_remote_dir(sftp_arc: &Arc<Mutex<SftpSession>>, path: &str) {
    let sftp = sftp_arc.lock().await;
    let _ = sftp.create_dir(path).await;
}

/// Copies one file into an already-created remote path.
/// Summary for the single file case, where there is no batch to report on.
fn single_file_summary(step: Step) -> TransferSummary {
    TransferSummary {
        files: if step == Step::Finished { 1 } else { 0 },
        cancelled: step == Step::Cancelled,
        ..Default::default()
    }
}

async fn upload_one(
    app: &tauri::AppHandle,
    sftp_arc: &Arc<Mutex<SftpSession>>,
    local_path: &Path,
    remote_path: &str,
    index: u32,
    count: u32,
    cancel: &AtomicBool,
) -> Result<Step, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let file_name = local_path.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let total = tokio::fs::metadata(local_path).await.map(|m| m.len()).unwrap_or(0);
    let mut local_file = tokio::fs::File::open(local_path)
        .await
        .map_err(|e| format!("{}: {}", local_path.display(), e))?;

    let mut remote_file = {
        let sftp = sftp_arc.lock().await;
        sftp.create(remote_path).await.map_err(|e| format!("{}: {}", remote_path, e))?
    };

    let mut buf = vec![0u8; CHUNK];
    let mut transferred = 0u64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            // A part written file is not a shorter file, it is a corrupt
            // one, and nothing here can resume it. Removing it is the honest
            // outcome; leaving it puts something that looks complete beside
            // the files that are.
            drop(remote_file);
            let sftp = sftp_arc.lock().await;
            let _ = sftp.remove_file(remote_path).await;
            return Ok(Step::Cancelled);
        }
        let n = local_file.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 { break; }
        remote_file.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
        transferred += n as u64;
        let _ = app.emit("sftp-progress", TransferProgress {
            file_name: file_name.clone(), transferred, total, file_index: index, file_count: count,
        });
    }
    remote_file.flush().await.map_err(|e| e.to_string())?;
    Ok(Step::Finished)
}

/// Uploads a file, or a directory tree rooted at `local_path`.
pub async fn upload_path(
    app: &tauri::AppHandle,
    sftp_state: &SftpClientState,
    session_id: &str,
    local_path: &str,
    remote_dir: &str,
) -> Result<TransferSummary, String> {
    let root = Path::new(local_path);
    let name = root.file_name().ok_or("Invalid local path")?.to_string_lossy().into_owned();
    let dest_root = join_remote(remote_dir, &name);
    let sftp_arc = get_session(sftp_state, session_id).await?;
    let cancel = sftp_state.begin_transfer();

    let meta = fs::metadata(root).map_err(|e| format!("{}: {}", root.display(), e))?;
    if !meta.is_dir() {
        let step = upload_one(app, &sftp_arc, root, &dest_root, 1, 1, &cancel).await?;
        return Ok(single_file_summary(step));
    }

    let (items, skipped_symlinks) = collect_local_tree(root)?;
    let files: Vec<&TreeItem> = items.iter().filter(|i| !i.is_dir).collect();
    let count = files.len() as u32;

    // Every directory first, so no file lands before its parent exists.
    ensure_remote_dir(&sftp_arc, &dest_root).await;
    let mut dirs = 0u32;
    for item in items.iter().filter(|i| i.is_dir) {
        ensure_remote_dir(&sftp_arc, &join_remote(&dest_root, &item.rel)).await;
        dirs += 1;
    }

    for (i, item) in files.iter().enumerate() {
        let step = upload_one(
            app,
            &sftp_arc,
            &root.join(&item.rel),
            &join_remote(&dest_root, &item.rel),
            i as u32 + 1,
            count,
            &cancel,
        )
        .await?;
        // Files already copied are left alone; only the one in flight is
        // removed. `files` therefore counts what actually arrived.
        if step == Step::Cancelled {
            return Ok(TransferSummary {
                files: i as u32, directories: dirs, skipped_symlinks, cancelled: true,
            });
        }
    }

    Ok(TransferSummary { files: count, directories: dirs, skipped_symlinks, cancelled: false })
}

async fn download_one(
    app: &tauri::AppHandle,
    sftp_arc: &Arc<Mutex<SftpSession>>,
    remote_path: &str,
    local_path: &Path,
    index: u32,
    count: u32,
    cancel: &AtomicBool,
) -> Result<Step, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let file_name = local_path.file_name().unwrap_or_default().to_string_lossy().into_owned();
    let (total, mut remote_file) = {
        let sftp = sftp_arc.lock().await;
        let meta = sftp.metadata(remote_path).await.map_err(|e| format!("{}: {}", remote_path, e))?;
        let f = sftp.open(remote_path).await.map_err(|e| format!("{}: {}", remote_path, e))?;
        (meta.size.unwrap_or(0), f)
    };

    let mut local_file = tokio::fs::File::create(local_path)
        .await
        .map_err(|e| format!("{}: {}", local_path.display(), e))?;

    let mut buf = vec![0u8; CHUNK];
    let mut transferred = 0u64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            // See upload_one.
            drop(local_file);
            let _ = tokio::fs::remove_file(local_path).await;
            return Ok(Step::Cancelled);
        }
        let n = remote_file.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 { break; }
        local_file.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
        transferred += n as u64;
        let _ = app.emit("sftp-progress", TransferProgress {
            file_name: file_name.clone(), transferred, total, file_index: index, file_count: count,
        });
    }
    local_file.flush().await.map_err(|e| e.to_string())?;
    Ok(Step::Finished)
}

/// Downloads a file, or a directory tree rooted at `remote_path`.
pub async fn download_path(
    app: &tauri::AppHandle,
    sftp_state: &SftpClientState,
    session_id: &str,
    remote_path: &str,
    local_dir: &str,
) -> Result<TransferSummary, String> {
    let name = Path::new(remote_path)
        .file_name()
        .ok_or("Invalid remote path")?
        .to_string_lossy()
        .into_owned();
    let dest_root = Path::new(local_dir).join(&name);
    let sftp_arc = get_session(sftp_state, session_id).await?;
    let cancel = sftp_state.begin_transfer();

    let is_dir = {
        let sftp = sftp_arc.lock().await;
        let meta = sftp.metadata(remote_path).await.map_err(|e| format!("{}: {}", remote_path, e))?;
        meta.file_type().is_dir()
    };

    if !is_dir {
        let step = download_one(app, &sftp_arc, remote_path, &dest_root, 1, 1, &cancel).await?;
        return Ok(single_file_summary(step));
    }

    let (items, skipped_symlinks) = collect_remote_tree(&sftp_arc, remote_path).await?;
    let files: Vec<&TreeItem> = items.iter().filter(|i| !i.is_dir).collect();
    let count = files.len() as u32;

    fs::create_dir_all(&dest_root).map_err(|e| format!("{}: {}", dest_root.display(), e))?;
    let mut dirs = 0u32;
    for item in items.iter().filter(|i| i.is_dir) {
        let path = dest_root.join(&item.rel);
        fs::create_dir_all(&path).map_err(|e| format!("{}: {}", path.display(), e))?;
        dirs += 1;
    }

    for (i, item) in files.iter().enumerate() {
        let step = download_one(
            app,
            &sftp_arc,
            &join_remote(remote_path, &item.rel),
            &dest_root.join(&item.rel),
            i as u32 + 1,
            count,
            &cancel,
        )
        .await?;
        // Files already copied are left alone; only the one in flight is
        // removed. `files` therefore counts what actually arrived.
        if step == Step::Cancelled {
            return Ok(TransferSummary {
                files: i as u32, directories: dirs, skipped_symlinks, cancelled: true,
            });
        }
    }

    Ok(TransferSummary { files: count, directories: dirs, skipped_symlinks, cancelled: false })
}

// Two sessions, two paths and the batch position. Collapsing these into a
// params struct belongs with the wider transfer dedup, not here.
#[allow(clippy::too_many_arguments)]
async fn copy_one(
    app: &tauri::AppHandle,
    src_arc: &Arc<Mutex<SftpSession>>,
    src_path: &str,
    dst_arc: &Arc<Mutex<SftpSession>>,
    dst_path: &str,
    index: u32,
    count: u32,
    cancel: &AtomicBool,
) -> Result<Step, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let file_name = Path::new(dst_path).file_name().unwrap_or_default().to_string_lossy().into_owned();

    let (total, mut src_file) = {
        let sftp = src_arc.lock().await;
        let meta = sftp.metadata(src_path).await.map_err(|e| format!("{}: {}", src_path, e))?;
        let f = sftp.open(src_path).await.map_err(|e| format!("{}: {}", src_path, e))?;
        (meta.size.unwrap_or(0), f)
    };
    let mut dst_file = {
        let sftp = dst_arc.lock().await;
        sftp.create(dst_path).await.map_err(|e| format!("{}: {}", dst_path, e))?
    };

    // Streamed rather than read whole into memory, so a large file does not
    // have to fit in RAM.
    let mut buf = vec![0u8; CHUNK];
    let mut transferred = 0u64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            // See upload_one.
            drop(dst_file);
            let sftp = dst_arc.lock().await;
            let _ = sftp.remove_file(dst_path).await;
            return Ok(Step::Cancelled);
        }
        let n = src_file.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 { break; }
        dst_file.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
        transferred += n as u64;
        let _ = app.emit("sftp-progress", TransferProgress {
            file_name: file_name.clone(), transferred, total, file_index: index, file_count: count,
        });
    }
    dst_file.flush().await.map_err(|e| e.to_string())?;
    Ok(Step::Finished)
}

/// Copies a file, or a directory tree, between two remote sessions.
pub async fn copy_remote_path(
    app: &tauri::AppHandle,
    sftp_state: &SftpClientState,
    src_session_id: &str,
    src_path: &str,
    dst_session_id: &str,
    dst_dir: &str,
) -> Result<TransferSummary, String> {
    let name = Path::new(src_path)
        .file_name()
        .ok_or("Invalid source path")?
        .to_string_lossy()
        .into_owned();
    let dest_root = join_remote(dst_dir, &name);

    let src_arc = get_session(sftp_state, src_session_id).await?;
    let dst_arc = get_session(sftp_state, dst_session_id).await?;
    let cancel = sftp_state.begin_transfer();

    let is_dir = {
        let sftp = src_arc.lock().await;
        let meta = sftp.metadata(src_path).await.map_err(|e| format!("{}: {}", src_path, e))?;
        meta.file_type().is_dir()
    };

    if !is_dir {
        let step = copy_one(app, &src_arc, src_path, &dst_arc, &dest_root, 1, 1, &cancel).await?;
        return Ok(single_file_summary(step));
    }

    let (items, skipped_symlinks) = collect_remote_tree(&src_arc, src_path).await?;
    let files: Vec<&TreeItem> = items.iter().filter(|i| !i.is_dir).collect();
    let count = files.len() as u32;

    ensure_remote_dir(&dst_arc, &dest_root).await;
    let mut dirs = 0u32;
    for item in items.iter().filter(|i| i.is_dir) {
        ensure_remote_dir(&dst_arc, &join_remote(&dest_root, &item.rel)).await;
        dirs += 1;
    }

    for (i, item) in files.iter().enumerate() {
        let step = copy_one(
            app,
            &src_arc,
            &join_remote(src_path, &item.rel),
            &dst_arc,
            &join_remote(&dest_root, &item.rel),
            i as u32 + 1,
            count,
            &cancel,
        )
        .await?;
        // Files already copied are left alone; only the one in flight is
        // removed. `files` therefore counts what actually arrived.
        if step == Step::Cancelled {
            return Ok(TransferSummary {
                files: i as u32, directories: dirs, skipped_symlinks, cancelled: true,
            });
        }
    }

    Ok(TransferSummary { files: count, directories: dirs, skipped_symlinks, cancelled: false })
}


pub fn create_local_dir(path: &str) -> Result<(), String> {
    std::fs::create_dir(path).map_err(|e| e.to_string())
}

pub fn delete_local(path: &str) -> Result<(), String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    if meta.is_dir() {
        std::fs::remove_dir_all(path).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(path).map_err(|e| e.to_string())
    }
}

pub fn rename_local(old_path: &str, new_path: &str) -> Result<(), String> {
    std::fs::rename(old_path, new_path).map_err(|e| e.to_string())
}

pub async fn delete_remote(
    sftp_state: &SftpClientState,
    session_id: &str,
    path: &str,
    is_dir: bool,
) -> Result<(), String> {
    let sftp_arc = get_session(sftp_state, session_id).await?;

    if !is_dir {
        let sftp = sftp_arc.lock().await;
        return sftp.remove_file(path).await.map_err(|e| e.to_string());
    }

    // remove_dir only works on an empty directory, so the tree has to come out
    // from the leaves upwards. The walk records a directory before its
    // descendants, so reversing the directory list deletes children first.
    let (items, _skipped) = collect_remote_tree(&sftp_arc, path).await?;
    let sftp = sftp_arc.lock().await;

    for item in items.iter().filter(|i| !i.is_dir) {
        let child = join_remote(path, &item.rel);
        sftp.remove_file(&child).await.map_err(|e| format!("{}: {}", child, e))?;
    }
    for item in items.iter().filter(|i| i.is_dir).rev() {
        let child = join_remote(path, &item.rel);
        sftp.remove_dir(&child).await.map_err(|e| format!("{}: {}", child, e))?;
    }
    sftp.remove_dir(path).await.map_err(|e| format!("{}: {}", path, e))
}

pub async fn rename_remote(
    sftp_state: &SftpClientState,
    session_id: &str,
    old_path: &str,
    new_path: &str,
) -> Result<(), String> {
    let sftp_arc = get_session(sftp_state, session_id).await?;
    let sftp = sftp_arc.lock().await;
    sftp.rename(old_path, new_path).await.map_err(|e| e.to_string())
}

pub async fn mkdir(
    sftp_state: &SftpClientState,
    session_id: &str,
    path: &str,
) -> Result<(), String> {
    let sftp_arc = get_session(sftp_state, session_id).await?;
    let sftp = sftp_arc.lock().await;
    sftp.create_dir(path).await.map_err(|e| e.to_string())
}

pub async fn disconnect_sftp(sftp_state: &SftpClientState, session_id: &str) {
    let removed = sftp_state.sessions.lock().await.remove(session_id);
    if let Some(sftp_arc) = removed {
        if let Ok(sftp) = sftp_arc.try_lock() {
            let _ = sftp.close().await;
        }
    }
}

async fn get_session(
    sftp_state: &SftpClientState,
    session_id: &str,
) -> Result<Arc<Mutex<SftpSession>>, String> {
    sftp_state.sessions.lock().await
        .get(session_id)
        .cloned()
        .ok_or_else(|| "SFTP session not found".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempTree(std::path::PathBuf);
    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn temp_tree(name: &str) -> TempTree {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir()
            .join(format!("bifrossh-tree-{}-{}-{}", std::process::id(), name, id));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        TempTree(dir)
    }

    #[test]
    fn walks_nested_directories() {
        let t = temp_tree("nested");
        let root = t.0.join("src");
        fs::create_dir_all(root.join("a/b")).unwrap();
        fs::write(root.join("top.txt"), b"1").unwrap();
        fs::write(root.join("a/mid.txt"), b"2").unwrap();
        fs::write(root.join("a/b/deep.txt"), b"3").unwrap();

        let (items, skipped) = collect_local_tree(&root).unwrap();
        assert_eq!(skipped, 0);

        let mut files: Vec<&str> = items.iter().filter(|i| !i.is_dir).map(|i| i.rel.as_str()).collect();
        files.sort();
        assert_eq!(files, vec!["a/b/deep.txt", "a/mid.txt", "top.txt"]);

        let mut dirs: Vec<&str> = items.iter().filter(|i| i.is_dir).map(|i| i.rel.as_str()).collect();
        dirs.sort();
        assert_eq!(dirs, vec!["a", "a/b"]);
    }

    /// Callers create parents before children and delete children before
    /// parents, both of which depend on this ordering.
    #[test]
    fn parents_are_recorded_before_their_children() {
        let t = temp_tree("order");
        let root = t.0.join("src");
        fs::create_dir_all(root.join("x/y/z")).unwrap();
        fs::write(root.join("x/y/z/f.txt"), b"1").unwrap();

        let (items, _) = collect_local_tree(&root).unwrap();
        let pos = |rel: &str| items.iter().position(|i| i.rel == rel).unwrap();

        assert!(pos("x") < pos("x/y"));
        assert!(pos("x/y") < pos("x/y/z"));
        assert!(pos("x/y/z") < pos("x/y/z/f.txt"));
    }

    /// A link pointing at an ancestor would otherwise be walked forever.
    #[test]
    #[cfg(unix)]
    fn symlinks_are_skipped_not_followed() {
        let t = temp_tree("symlink");
        let root = t.0.join("src");
        fs::create_dir_all(root.join("real")).unwrap();
        fs::write(root.join("real/f.txt"), b"1").unwrap();
        std::os::unix::fs::symlink(&root, root.join("loop")).unwrap();
        std::os::unix::fs::symlink(root.join("real/f.txt"), root.join("link.txt")).unwrap();

        let (items, skipped) = collect_local_tree(&root).unwrap();

        assert_eq!(skipped, 2, "both the directory loop and the file link are skipped");
        assert!(
            !items.iter().any(|i| i.rel.starts_with("loop")),
            "the loop must not be entered"
        );
        assert!(items.iter().any(|i| i.rel == "real/f.txt"));
    }

    #[test]
    fn an_empty_directory_walks_cleanly() {
        let t = temp_tree("empty");
        let root = t.0.join("src");
        fs::create_dir_all(&root).unwrap();

        let (items, skipped) = collect_local_tree(&root).unwrap();
        assert!(items.is_empty());
        assert_eq!(skipped, 0);
    }

    #[test]
    fn remote_paths_join_without_doubling_slashes() {
        assert_eq!(join_remote("/", "f.txt"), "/f.txt");
        assert_eq!(join_remote("/home/x", "f.txt"), "/home/x/f.txt");
        assert_eq!(join_remote("/home/x/", "f.txt"), "/home/x/f.txt");
        assert_eq!(join_remote("/home/x", "a/b.txt"), "/home/x/a/b.txt");
    }
}
