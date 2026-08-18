use tauri::State;

use crate::models::*;
use crate::store::save_app_data;

use super::AppState;

// ── Settings ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    Ok(state.data.lock().await.settings.clone())
}

#[tauri::command]
pub async fn save_settings(
    state: State<'_, AppState>,
    settings: Settings,
) -> Result<(), String> {
    let mut data = state.data.lock().await;
    data.settings = settings;
    save_app_data(&data, &state.key()?).map_err(|e| e.to_string())
}
