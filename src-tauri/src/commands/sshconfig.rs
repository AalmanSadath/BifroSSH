use std::collections::HashMap;
use tauri::State;
use uuid::Uuid;

use crate::models::*;

use super::{CmdError, CmdResult};
use super::AppState;
use super::keys::detect_algorithm;

// ── ssh_config import ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn scan_ssh_config() -> CmdResult<crate::sshconfig::SshConfigScan> {
    crate::sshconfig::scan().map_err(CmdError::from)
}

#[derive(serde::Serialize)]
pub struct SshConfigImport {
    pub imported: u32,
    pub skipped_existing: u32,
    pub keys_linked: u32,
    pub jumps_linked: u32,
}

/// Creates hosts from selected ssh_config entries.
///
/// An entry whose host, port and username already match a saved server is
/// skipped, so running the import twice does not produce duplicates.
#[tauri::command]
pub async fn import_ssh_config_hosts(
    state: State<'_, AppState>,
    aliases: Vec<String>,
) -> CmdResult<SshConfigImport> {
    let scan = crate::sshconfig::scan()?;
    let mut data = state.data.lock().await;
    let mut result = SshConfigImport { imported: 0, skipped_existing: 0, keys_linked: 0, jumps_linked: 0 };
    // ProxyJump names another alias, which may not exist as a server until
    // later in this same loop, so the links are made in a second pass.
    let mut by_alias: HashMap<String, String> = HashMap::new();

    for alias in &aliases {
        let Some(entry) = scan.hosts.iter().find(|h| &h.alias == alias) else { continue };
        let port = entry.port.unwrap_or(22);

        let duplicate = data.servers.iter().any(|s| {
            s.host == entry.hostname
                && s.port == port
                && s.username.as_deref() == entry.user.as_deref()
        });
        if duplicate {
            result.skipped_existing += 1;
            continue;
        }

        // Reference the key by path rather than copying it into the keychain:
        // the file stays where ssh expects it, and no private key is duplicated.
        let key_id = match entry.identity_file.as_ref() {
            Some(path) if std::path::Path::new(path).exists() => {
                let existing = data.keys.iter().find(|k| k.key_path.as_deref() == Some(path.as_str()));
                if let Some(key) = existing {
                    Some(key.id.clone())
                } else {
                    let name = std::path::Path::new(path)
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| alias.clone());
                    let algorithm = std::fs::read_to_string(path).ok().and_then(|c| detect_algorithm(&c));
                    let key = KeyEntry {
                        id: Uuid::new_v4().to_string(),
                        name,
                        key_path: Some(path.clone()),
                        encrypted_key: None,
                        encrypted_passphrase: None,
                        algorithm,
                    };
                    let id = key.id.clone();
                    data.keys.push(key);
                    result.keys_linked += 1;
                    Some(id)
                }
            }
            _ => None,
        };

        let id = Uuid::new_v4().to_string();
        by_alias.insert(entry.alias.clone(), id.clone());
        data.servers.push(Server {
            id,
            name: entry.alias.clone(),
            host: entry.hostname.clone(),
            port,
            identity_id: None,
            username: entry.user.clone(),
            encrypted_password: None,
            key_id,
            theme: None,
            os: String::new(),
            connection_timeout: None,
            auth_kind: None,
            proxy_jump: None,
        });
        result.imported += 1;
    }

    // A jump host that was not imported alongside its target cannot be linked
    // to anything, so that host is left as a direct connection rather than
    // pointing at a server that does not exist.
    for alias in &aliases {
        let Some(entry) = scan.hosts.iter().find(|h| &h.alias == alias) else { continue };
        let Some(jump) = entry.proxy_jump.as_deref().and_then(crate::sshconfig::jump_alias) else { continue };
        let Some(jump_id) = by_alias.get(jump) else { continue };
        let Some(server_id) = by_alias.get(alias) else { continue };
        if jump_id == server_id {
            continue; // A host declaring itself its own jump host is a loop.
        }
        let jump_id = jump_id.clone();
        if let Some(server) = data.servers.iter_mut().find(|s| &s.id == server_id) {
            server.proxy_jump = Some(jump_id);
            result.jumps_linked += 1;
        }
    }

    state.save(&data)?;
    Ok(result)
}
