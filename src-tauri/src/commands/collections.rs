use tauri::State;

use crate::models::*;

use super::CmdResult;
use super::AppState;

// ── User collections ─────────────────────────────────────────────────────────
//
// Port forwardings, codeprints and custom themes used to live in webview
// localStorage, where clearing browsing data destroyed them and no backup of
// data.json included them. They are small and always rewritten wholesale by
// the UI, so a get/save pair each is enough.

#[tauri::command]
pub async fn get_port_forwardings(state: State<'_, AppState>) -> CmdResult<Vec<PortForwarding>> {
    Ok(state.data.lock().await.port_forwardings.clone())
}

#[tauri::command]
pub async fn save_port_forwardings(
    state: State<'_, AppState>,
    items: Vec<PortForwarding>,
) -> CmdResult<()> {
    let mut data = state.data.lock().await;
    data.port_forwardings = items;
    state.save(&data)
}

#[tauri::command]
pub async fn get_codeprints(state: State<'_, AppState>) -> CmdResult<Vec<Codeprint>> {
    Ok(state.data.lock().await.codeprints.clone())
}

#[tauri::command]
pub async fn save_codeprints(
    state: State<'_, AppState>,
    items: Vec<Codeprint>,
) -> CmdResult<()> {
    let mut data = state.data.lock().await;
    data.codeprints = items;
    state.save(&data)
}

#[tauri::command]
pub async fn get_sftp_bookmarks(state: State<'_, AppState>) -> CmdResult<Vec<SftpBookmark>> {
    Ok(state.data.lock().await.sftp_bookmarks.clone())
}

#[tauri::command]
pub async fn save_sftp_bookmarks(
    state: State<'_, AppState>,
    items: Vec<SftpBookmark>,
) -> CmdResult<()> {
    let mut data = state.data.lock().await;
    data.sftp_bookmarks = items;
    state.save(&data)
}

/// The hosts whose tabs were open last time, in strip order.
#[tauri::command]
pub async fn get_open_tabs(state: State<'_, AppState>) -> CmdResult<Vec<crate::models::OpenTab>> {
    Ok(state.data.lock().await.open_tabs.clone())
}

#[tauri::command]
pub async fn save_open_tabs(
    state: State<'_, AppState>,
    items: Vec<crate::models::OpenTab>,
) -> CmdResult<()> {
    let mut data = state.data.lock().await;
    data.open_tabs = items;
    state.save(&data)
}

#[tauri::command]
pub async fn get_custom_themes(
    state: State<'_, AppState>,
) -> CmdResult<std::collections::HashMap<String, serde_json::Value>> {
    Ok(state.data.lock().await.custom_themes.clone())
}

#[tauri::command]
pub async fn save_custom_themes(
    state: State<'_, AppState>,
    items: std::collections::HashMap<String, serde_json::Value>,
) -> CmdResult<()> {
    let mut data = state.data.lock().await;
    data.custom_themes = items;
    state.save(&data)
}

// ── Command history ──────────────────────────────────────────────────────────

/// What has been run at a prompt on this host, most recent first.
#[tauri::command]
pub async fn get_command_history(state: State<'_, AppState>, server_id: String) -> CmdResult<Vec<String>> {
    Ok(state.data.lock().await.command_history.get(&server_id).cloned().unwrap_or_default())
}

/// Adds commands run on a host, oldest first. The frontend batches them,
/// since every save rewrites the encrypted file.
#[tauri::command]
pub async fn record_commands(
    state: State<'_, AppState>,
    server_id: String,
    commands: Vec<String>,
) -> CmdResult<()> {
    let mut data = state.data.lock().await;
    // A host deleted while its commands were waiting to be written.
    if !data.servers.iter().any(|s| s.id == server_id) {
        return Ok(());
    }
    remember_commands(data.command_history.entry(server_id).or_default(), &commands);
    state.save(&data)
}

/// Forgets one host's history, or every host's.
#[tauri::command]
pub async fn clear_command_history(state: State<'_, AppState>, server_id: Option<String>) -> CmdResult<()> {
    let mut data = state.data.lock().await;
    match server_id {
        Some(id) => {
            data.command_history.remove(&id);
        }
        None => data.command_history.clear(),
    }
    state.save(&data)
}
