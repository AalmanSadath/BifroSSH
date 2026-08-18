use tauri::State;
use uuid::Uuid;

use crate::models::*;

use super::CmdResult;
use super::AppState;

// ── Servers ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_servers(state: State<'_, AppState>) -> CmdResult<Vec<Server>> {
    let data = state.data.lock().await;
    let safe = data.servers.iter().map(|s| Server {
        encrypted_password: s.encrypted_password.as_ref().map(|_| "[stored]".to_string()),
        ..s.clone()
    }).collect();
    Ok(safe)
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
        data.servers.iter().find(|s| s.id == server.id).and_then(|s| s.encrypted_password.clone())
    } else {
        None
    };

    // Keyboard-interactive answers are typed per connection and never stored,
    // so no stale password should linger alongside it.
    let uses_prompts = server.auth_kind.as_deref() == Some("keyboard-interactive");
    let encrypted_password = if server.key_id.is_some() || uses_prompts { None } else { encrypted_password };

    let server = Server {
        id: if server.id.is_empty() { Uuid::new_v4().to_string() } else { server.id },
        encrypted_password,
        ..server
    };

    match data.servers.iter().position(|s| s.id == server.id) {
        Some(idx) => data.servers[idx] = server.clone(),
        None => data.servers.push(server.clone()),
    }
    state.save(&data)?;

    Ok(Server {
        encrypted_password: server.encrypted_password.as_ref().map(|_| "[stored]".to_string()),
        ..server
    })
}

#[tauri::command]
pub async fn get_server_password(
    state: State<'_, AppState>,
    server_id: String,
) -> CmdResult<String> {
    let data = state.data.lock().await;
    let server = data.servers.iter().find(|s| s.id == server_id).ok_or("Server not found")?;
    let enc = server.encrypted_password.as_ref().ok_or("No password stored for this server")?;
    state.decrypt_str(enc)
}

#[tauri::command]
pub async fn delete_server(state: State<'_, AppState>, server_id: String) -> CmdResult<()> {
    let mut data = state.data.lock().await;
    data.servers.retain(|s| s.id != server_id);
    state.save(&data)
}
