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

/// The monospace families fontconfig can actually see, for the font picker.
///
/// Shelling out to `fc-list` rather than linking fontconfig: the binary is
/// present both on a normal desktop and in the Flatpak runtime, and this runs
/// once when Settings opens rather than on any hot path.
///
/// Offering only installed families matters because the setting feeds straight
/// into xterm's `fontFamily`. A name nothing resolves silently falls back to
/// whatever the webview picks, which looks like the setting was ignored.
#[tauri::command]
pub async fn list_fonts() -> CmdResult<Vec<String>> {
    let out = tokio::process::Command::new("fc-list")
        .args([":mono", "family"])
        .output()
        .await?;
    if !out.status.success() {
        return Err("Could not list installed fonts".into());
    }

    let mut families: Vec<String> = String::from_utf8_lossy(&out.stdout)
        .lines()
        // Each line is the family and its aliases, canonical name first, so the
        // weight variants of one family collapse onto the family itself.
        .filter_map(|l| l.split(',').next())
        .map(str::trim)
        // Emoji fonts are fixed advance and so match :mono, but nobody wants a
        // terminal rendered in one.
        .filter(|f| !f.is_empty() && !f.to_lowercase().contains("emoji"))
        .map(str::to_string)
        .collect();

    // Both steps compare the same way. Sorting case-insensitively and then
    // deduplicating case-sensitively let "Fira Code" and "fira code" sit next
    // to each other in the list and both survive.
    families.sort_unstable_by_key(|f| f.to_lowercase());
    families.dedup_by_key(|f| f.to_lowercase());
    Ok(families)
}
