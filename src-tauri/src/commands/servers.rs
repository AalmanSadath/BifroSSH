use tauri::State;
use uuid::Uuid;

use crate::models::*;

use super::records::*;
use super::CmdResult;
use super::AppState;

// ── Servers ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_servers(state: State<'_, AppState>) -> CmdResult<Vec<Server>> {
    let data = state.data.lock().await;
    Ok(data.servers.iter().cloned().map(Redacted::redacted).collect())
}

#[tauri::command]
pub async fn save_server(
    state: State<'_, AppState>,
    server: Server,
    password: Option<String>,
) -> CmdResult<Server> {
    let mut data = state.data.lock().await;

    let encrypted_password = if let Some(pw) = password.filter(|p| !p.is_empty()) {
        Some(state.encrypt(pw.as_bytes())?)
    } else if !server.id.is_empty() {
        find_by_id(&data.servers, &server.id).and_then(|s| s.encrypted_password.clone())
    } else {
        None
    };

    // Keyboard-interactive answers are typed per connection and never stored,
    // so no stale password should linger alongside it.
    let uses_prompts = server.auth_kind == Some(AuthKind::KeyboardInteractive);
    let encrypted_password = if server.key_id.is_some() || uses_prompts { None } else { encrypted_password };

    let server = Server {
        id: if server.id.is_empty() { Uuid::new_v4().to_string() } else { server.id },
        encrypted_password,
        ..server
    };

    upsert_by_id(&mut data.servers, server.clone());
    state.save(&data)?;

    Ok(server.redacted())
}

#[tauri::command]
pub async fn get_server_password(
    state: State<'_, AppState>,
    server_id: String,
) -> CmdResult<String> {
    let data = state.data.lock().await;
    let server = find_by_id(&data.servers, &server_id).ok_or("Server not found")?;
    let enc = server.encrypted_password.as_ref().ok_or("No password stored for this server")?;
    state.decrypt_str(enc)
}

#[tauri::command]
pub async fn delete_server(state: State<'_, AppState>, server_id: String) -> CmdResult<()> {
    let mut data = state.data.lock().await;
    remove_servers(&mut data, &[server_id]);
    state.save(&data)
}

/// Deletes several hosts with one write.
///
/// Not a loop over `delete_server` from the frontend: every save rewrites and
/// re-encrypts the whole data file and refreshes its one backup, so N deletes
/// cost N rewrites and leave the backup holding only the state before the
/// last, rather than before the batch.
#[tauri::command]
pub async fn delete_servers(state: State<'_, AppState>, server_ids: Vec<String>) -> CmdResult<()> {
    let mut data = state.data.lock().await;
    remove_servers(&mut data, &server_ids);
    state.save(&data)
}

/// Puts several hosts in one group, or in none, with one write.
#[tauri::command]
pub async fn set_servers_group(
    state: State<'_, AppState>,
    server_ids: Vec<String>,
    group: Option<String>,
) -> CmdResult<Vec<Server>> {
    let group = group.map(|g| g.trim().to_string()).filter(|g| !g.is_empty());
    let mut data = state.data.lock().await;
    for server in data.servers.iter_mut().filter(|s| server_ids.contains(&s.id)) {
        server.group = group.clone();
    }
    state.save(&data)?;
    Ok(data.servers.iter().cloned().map(Redacted::redacted).collect())
}
