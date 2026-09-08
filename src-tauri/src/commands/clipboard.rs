use tauri::AppHandle;

use super::CmdResult;

// ── Clipboard ────────────────────────────────────────────────────────────────

/// The clipboard's text, for the paste routes the webview will not serve.
///
/// The frontend asks the browser first and only falls back to this, so on the
/// keyboard path this is never called. See `src/clipboard/mod.rs` for why the
/// right-click path has no other option.
#[tauri::command]
pub async fn clipboard_read_text(app: AppHandle) -> CmdResult<String> {
    let text = tokio::task::spawn_blocking(move || crate::clipboard::read_text(&app))
        .await
        .map_err(|e| format!("Clipboard read failed: {e}"))??;
    Ok(text)
}
