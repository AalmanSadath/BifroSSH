use tauri::State;
use uuid::Uuid;

use crate::importers::{self, ForeignHost, ForeignScan, Source};
use crate::models::{Server, UNDETECTED_OS};

use super::AppState;
use super::{CmdError, CmdResult};

// ── Importing another client's saved hosts ───────────────────────────────────

/// An export is a list of hosts, not a disk image. Past this it is the wrong
/// file, and reading it would only be a way to spend memory.
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024;

/// One host from the file, as the dialog shows it.
#[derive(serde::Serialize)]
pub struct ScannedHost {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    pub group: Option<String>,
    /// A saved host already has this address, port and user, so importing it
    /// again would only make a second copy.
    pub already_here: bool,
    /// The file carries a password for it. The password itself stays in the
    /// backend: the frontend has no reason to hold one in a variable.
    pub has_password: bool,
}

#[derive(serde::Serialize)]
pub struct ClientScan {
    /// Which client wrote the file, for the dialog's heading.
    pub source: Source,
    pub hosts: Vec<ScannedHost>,
    pub skipped: Vec<String>,
}

#[derive(serde::Serialize)]
pub struct ClientImport {
    pub imported: u32,
    pub skipped_existing: u32,
    pub passwords_saved: u32,
    /// Groups the imported hosts landed in that no saved host used before.
    pub groups_created: u32,
}

/// Reads an export without changing anything, so the dialog can show what is
/// in it.
#[tauri::command]
pub async fn scan_client_export(state: State<'_, AppState>, path: String) -> CmdResult<ClientScan> {
    let scan = read_and_parse(&path)?;
    let data = state.data.lock().await;
    let hosts = scan
        .hosts
        .iter()
        .map(|h| ScannedHost {
            name: h.name.clone(),
            host: h.host.clone(),
            port: h.port,
            username: h.username.clone(),
            group: h.group.clone(),
            already_here: is_duplicate(&data.servers, h),
            has_password: h.password.is_some(),
        })
        .collect();
    Ok(ClientScan { source: scan.source, hosts, skipped: scan.skipped })
}

/// Creates hosts from the rows the user ticked.
///
/// The file is read again rather than the frontend being asked to send back
/// what it was shown, which is how the ssh_config import works too: what gets
/// saved is then what is in the file, whatever a page in a webview has done
/// with it since. The rows are named by position, so a file that changed under
/// the dialog is refused rather than importing the wrong lines.
#[tauri::command]
pub async fn import_client_hosts(
    state: State<'_, AppState>,
    path: String,
    picked: Vec<usize>,
    total: usize,
    with_passwords: bool,
) -> CmdResult<ClientImport> {
    let scan = read_and_parse(&path)?;
    if scan.hosts.len() != total {
        return Err(CmdError::from(
            "The file changed since it was read. Open it again to see what is in it now.",
        ));
    }
    // A password can only be saved encrypted, so a locked vault has to fail
    // before anything is merged rather than halfway through it.
    if with_passwords && scan.hosts.iter().any(|h| h.password.is_some()) {
        state.key()?;
    }

    let mut data = state.data.lock().await;
    let groups_before: std::collections::HashSet<String> = data
        .servers
        .iter()
        .filter_map(|s| s.group.clone())
        .collect();
    let mut result = ClientImport { imported: 0, skipped_existing: 0, passwords_saved: 0, groups_created: 0 };

    for index in picked {
        let Some(host) = scan.hosts.get(index) else { continue };
        if is_duplicate(&data.servers, host) {
            result.skipped_existing += 1;
            continue;
        }
        let password = with_passwords.then_some(host.password.as_deref()).flatten();
        let encrypted_password = match password {
            Some(secret) => {
                result.passwords_saved += 1;
                Some(state.encrypt(secret.as_bytes())?)
            }
            None => None,
        };
        data.servers.push(Server {
            id: Uuid::new_v4().to_string(),
            name: host.name.clone(),
            host: host.host.clone(),
            port: host.port,
            identity_id: None,
            username: host.username.clone(),
            encrypted_password,
            key_id: None,
            theme: None,
            // Left as the sentinel for "nobody has looked yet", so the icon is
            // detected on the first connect like any other new host.
            os: UNDETECTED_OS.to_string(),
            connection_timeout: None,
            // None is what a host with a saved password has: `AuthKind` names
            // the two methods that are not a password.
            auth_kind: None,
            proxy_jump: None,
            forward_agent: false,
            log_sessions: false,
            group: host.group.clone(),
            run_on_connect: None,
            hide_run_on_connect: true,
            notes: host.notes.clone(),
            term: None,
            env: None,
        });
        result.imported += 1;
    }

    result.groups_created = data
        .servers
        .iter()
        .filter_map(|s| s.group.as_ref())
        .filter(|g| !groups_before.contains(*g))
        .collect::<std::collections::HashSet<_>>()
        .len() as u32;
    state.save(&data)?;
    Ok(result)
}

fn read_and_parse(path: &str) -> CmdResult<ForeignScan> {
    let bytes = read_capped(std::path::Path::new(path))?;
    // PuTTY on Unix keeps one file per session, and a session's name is its
    // file's name, so one file on its own can only be named after the address
    // it holds. Picking any one of them imports the lot, which is what the
    // user meant by pointing at the directory they were in.
    if importers::is_one_putty_session(&bytes) {
        if let Some(files) = sibling_sessions(std::path::Path::new(path)) {
            return Ok(importers::parse_putty_dir(&files));
        }
    }
    importers::parse(&bytes).map_err(CmdError::from)
}

/// Every other file beside this one, name and contents, when this file is in a
/// directory PuTTY would have written. `None` when it is somewhere else, so the
/// file is read on its own instead.
fn sibling_sessions(path: &std::path::Path) -> Option<Vec<(String, Vec<u8>)>> {
    let dir = path.parent()?;
    if dir.file_name()? != "sessions" {
        return None;
    }
    let mut files: Vec<(String, Vec<u8>)> = std::fs::read_dir(dir)
        .ok()?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            entry.file_type().ok()?.is_file().then_some(())?;
            let name = entry.file_name().to_string_lossy().to_string();
            Some((name, read_capped(&entry.path()).ok()?))
        })
        .collect();
    // Read order is the filesystem's; the list the user sees should not be.
    files.sort_by(|(a, _), (b, _)| a.cmp(b));
    (!files.is_empty()).then_some(files)
}

fn read_capped(path: &std::path::Path) -> CmdResult<Vec<u8>> {
    let shown = path.display();
    let meta = std::fs::metadata(path).map_err(|e| CmdError::from(format!("{shown}: {e}")))?;
    if meta.len() > MAX_FILE_BYTES {
        return Err(CmdError::from(format!(
            "{shown} is {} MB, far larger than any list of hosts. Is that the right file?",
            meta.len() / (1024 * 1024)
        )));
    }
    std::fs::read(path).map_err(|e| CmdError::from(format!("{shown}: {e}")))
}

/// The same test the ssh_config import and the backup merge use: a host is
/// the address, the port and the user, not the name somebody gave it.
fn is_duplicate(servers: &[Server], host: &ForeignHost) -> bool {
    servers.iter().any(|s| {
        s.host == host.host && s.port == host.port && s.username.as_deref() == host.username.as_deref()
    })
}
