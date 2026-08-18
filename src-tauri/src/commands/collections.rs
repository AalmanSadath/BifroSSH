use tauri::State;

use crate::models::*;
use crate::store::save_app_data;

use super::AppState;

// ── User collections ─────────────────────────────────────────────────────────
//
// Port forwardings, codeprints and custom themes used to live in webview
// localStorage, where clearing browsing data destroyed them and no backup of
// data.json included them. They are small and always rewritten wholesale by
// the UI, so a get/save pair each is enough.

#[tauri::command]
pub async fn get_port_forwardings(state: State<'_, AppState>) -> Result<Vec<PortForwarding>, String> {
    Ok(state.data.lock().await.port_forwardings.clone())
}

#[tauri::command]
pub async fn save_port_forwardings(
    state: State<'_, AppState>,
    items: Vec<PortForwarding>,
) -> Result<(), String> {
    let mut data = state.data.lock().await;
    data.port_forwardings = items;
    save_app_data(&data, &state.key()?).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_codeprints(state: State<'_, AppState>) -> Result<Vec<Codeprint>, String> {
    Ok(state.data.lock().await.codeprints.clone())
}

#[tauri::command]
pub async fn save_codeprints(
    state: State<'_, AppState>,
    items: Vec<Codeprint>,
) -> Result<(), String> {
    let mut data = state.data.lock().await;
    data.codeprints = items;
    save_app_data(&data, &state.key()?).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_custom_themes(
    state: State<'_, AppState>,
) -> Result<std::collections::HashMap<String, serde_json::Value>, String> {
    Ok(state.data.lock().await.custom_themes.clone())
}

#[tauri::command]
pub async fn save_custom_themes(
    state: State<'_, AppState>,
    items: std::collections::HashMap<String, serde_json::Value>,
) -> Result<(), String> {
    let mut data = state.data.lock().await;
    data.custom_themes = items;
    save_app_data(&data, &state.key()?).map_err(|e| e.to_string())
}
