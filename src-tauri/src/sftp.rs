use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::SystemTime;

use anyhow::Result;
use async_trait::async_trait;
use russh::*;
use russh_keys::key::KeyPair;
use russh_sftp::client::SftpSession;
use serde::Serialize;
use tauri::Emitter;
use tokio::sync::Mutex;
use tokio::time::Duration;

const CHUNK: usize = 128 * 1024; // 128 KB

#[derive(Serialize, Clone)]
pub struct TransferProgress {
    pub file_name: String,
    pub transferred: u64,
    pub total: u64,
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
}

impl SftpClientState {
    pub fn new() -> Self {
        Self { sessions: Mutex::new(HashMap::new()) }
    }
}

struct SftpClientHandler;

#[async_trait]
impl client::Handler for SftpClientHandler {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        _key: &russh_keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
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

pub async fn connect_sftp(
    sftp_state: &SftpClientState,
    session_id: &str,
    host: &str,
    port: u16,
    username: &str,
    key_pem: Option<&str>,
    passphrase: Option<&str>,
    password: Option<&str>,
    inactivity_timeout_secs: u32,
) -> Result<(), String> {
    tokio::time::timeout(
        Duration::from_secs(30),
        connect_sftp_inner(sftp_state, session_id, host, port, username, key_pem, passphrase, password, inactivity_timeout_secs),
    )
    .await
    .map_err(|_| "Connection timed out after 30 seconds".to_string())?
}

async fn connect_sftp_inner(
    sftp_state: &SftpClientState,
    session_id: &str,
    host: &str,
    port: u16,
    username: &str,
    key_pem: Option<&str>,
    passphrase: Option<&str>,
    password: Option<&str>,
    inactivity_timeout_secs: u32,
) -> Result<(), String> {
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(inactivity_timeout_secs as u64)),
        ..Default::default()
    });

    let mut addrs = tokio::net::lookup_host(format!("{}:{}", host, port)).await
        .map_err(|e| e.to_string())?;
    let addr = addrs.next().ok_or_else(|| "Cannot resolve host".to_string())?;

    let mut handle = client::connect(config, addr, SftpClientHandler).await
        .map_err(|e| e.to_string())?;

    let authenticated = if let Some(pw) = password {
        handle.authenticate_password(username, pw).await.map_err(|e| e.to_string())?
    } else if let Some(pem) = key_pem {
        let kp: KeyPair = russh_keys::decode_secret_key(pem, passphrase)
            .map_err(|e| e.to_string())?;
        handle.authenticate_publickey(username, Arc::new(kp)).await.map_err(|e| e.to_string())?
    } else {
        return Err("No authentication provided".into());
    };

    if !authenticated { return Err("Authentication failed".into()); }

    let channel = handle.channel_open_session().await.map_err(|e| e.to_string())?;
    channel.request_subsystem(true, "sftp").await.map_err(|e| e.to_string())?;

    let sftp = SftpSession::new(channel.into_stream()).await.map_err(|e| e.to_string())?;

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

pub async fn upload_file(
    app: &tauri::AppHandle,
    sftp_state: &SftpClientState,
    session_id: &str,
    local_path: &str,
    remote_dir: &str,
) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let file_name = Path::new(local_path)
        .file_name()
        .ok_or("Invalid local path")?
        .to_string_lossy()
        .into_owned();
    let remote_path = if remote_dir == "/" {
        format!("/{}", file_name)
    } else {
        format!("{}/{}", remote_dir.trim_end_matches('/'), file_name)
    };

    let total = tokio::fs::metadata(local_path).await.map(|m| m.len()).unwrap_or(0);
    let mut local_file = tokio::fs::File::open(local_path).await.map_err(|e| e.to_string())?;

    let sftp_arc = get_session(sftp_state, session_id).await?;
    let mut remote_file = {
        let sftp = sftp_arc.lock().await;
        sftp.create(&remote_path).await.map_err(|e| e.to_string())?
    };

    let mut buf = vec![0u8; CHUNK];
    let mut transferred = 0u64;
    loop {
        let n = local_file.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 { break; }
        remote_file.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
        transferred += n as u64;
        let _ = app.emit("sftp-progress", TransferProgress { file_name: file_name.clone(), transferred, total });
    }
    remote_file.flush().await.map_err(|e| e.to_string())?;

    Ok(())
}

pub async fn download_file(
    app: &tauri::AppHandle,
    sftp_state: &SftpClientState,
    session_id: &str,
    remote_path: &str,
    local_dir: &str,
) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let file_name = Path::new(remote_path)
        .file_name()
        .ok_or("Invalid remote path")?
        .to_string_lossy()
        .into_owned();
    let local_path = std::path::Path::new(local_dir).join(&file_name);

    let sftp_arc = get_session(sftp_state, session_id).await?;
    let (total, mut remote_file) = {
        let sftp = sftp_arc.lock().await;
        let meta = sftp.metadata(remote_path).await.map_err(|e| e.to_string())?;
        let total = meta.size.unwrap_or(0);
        let f = sftp.open(remote_path).await.map_err(|e| e.to_string())?;
        (total, f)
    };

    let mut local_file = tokio::fs::File::create(&local_path).await.map_err(|e| e.to_string())?;
    let mut buf = vec![0u8; CHUNK];
    let mut transferred = 0u64;
    loop {
        let n = remote_file.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 { break; }
        local_file.write_all(&buf[..n]).await.map_err(|e| e.to_string())?;
        transferred += n as u64;
        let _ = app.emit("sftp-progress", TransferProgress { file_name: file_name.clone(), transferred, total });
    }

    Ok(())
}

pub async fn copy_remote_to_remote(
    app: &tauri::AppHandle,
    sftp_state: &SftpClientState,
    src_session_id: &str,
    src_path: &str,
    dst_session_id: &str,
    dst_dir: &str,
) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let file_name = Path::new(src_path)
        .file_name()
        .ok_or("Invalid source path")?
        .to_string_lossy()
        .into_owned();

    let src_arc = get_session(sftp_state, src_session_id).await?;
    let (total, data) = {
        let sftp = src_arc.lock().await;
        let meta = sftp.metadata(src_path).await.map_err(|e| e.to_string())?;
        let total = meta.size.unwrap_or(0);
        let mut f = sftp.open(src_path).await.map_err(|e| e.to_string())?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf).await.map_err(|e| e.to_string())?;
        (total, buf)
    };

    let dst_path = if dst_dir == "/" {
        format!("/{}", file_name)
    } else {
        format!("{}/{}", dst_dir.trim_end_matches('/'), file_name)
    };

    let dst_arc = get_session(sftp_state, dst_session_id).await?;
    let mut remote_file = {
        let sftp = dst_arc.lock().await;
        sftp.create(&dst_path).await.map_err(|e| e.to_string())?
    };

    let mut offset = 0usize;
    while offset < data.len() {
        let end = (offset + CHUNK).min(data.len());
        remote_file.write_all(&data[offset..end]).await.map_err(|e| e.to_string())?;
        offset = end;
        let _ = app.emit("sftp-progress", TransferProgress { file_name: file_name.clone(), transferred: offset as u64, total });
    }
    remote_file.flush().await.map_err(|e| e.to_string())?;

    Ok(())
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
    let sftp = sftp_arc.lock().await;
    if is_dir {
        sftp.remove_dir(path).await.map_err(|e| e.to_string())
    } else {
        sftp.remove_file(path).await.map_err(|e| e.to_string())
    }
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
