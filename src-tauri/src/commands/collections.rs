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
