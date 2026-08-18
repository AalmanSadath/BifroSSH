use tauri::State;

use crate::models::*;

use super::CmdResult;
use super::AppState;

// ── Settings ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> CmdResult<Settings> {
    Ok(state.data.lock().await.settings.clone())
}

#[tauri::command]
pub async fn save_settings(
    state: State<'_, AppState>,
    settings: Settings,
) -> CmdResult<()> {
    let mut data = state.data.lock().await;
    data.settings = settings;
    state.save(&data)
}
