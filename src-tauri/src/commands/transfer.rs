use tauri::State;

use crate::store::save_app_data;

use super::AppState;

// ── Export and import ────────────────────────────────────────────────────────

/// Where an export should land by default. Somewhere the user will find it,
/// which is Downloads if they have one.
#[tauri::command]
pub async fn default_export_dir() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Could not find your home directory")?;
    let downloads = home.join("Downloads");
    let dir = if downloads.is_dir() { downloads } else { home };
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn export_data(
    state: State<'_, AppState>,
    path: String,
    passphrase: String,
    include_secrets: bool,
    overwrite: bool,
) -> Result<crate::transfer::ExportResult, String> {
    // Checked before anything is built, so a refusal costs nothing and cannot
    // be mistaken for a write that half happened.
    if !overwrite && std::path::Path::new(&path).exists() {
        return Err(format!("{path} already exists"));
    }

    let key = state.key()?;
    let (content, counts) = {
        let data = state.data.lock().await;
        crate::transfer::build_export(&data, &key, &passphrase, include_secrets)
            .map_err(|e| format!("{e:#}"))?
    };

    // write_private, so the file is owner-only from the moment it exists
    // rather than after a chmod that a reader could beat.
    crate::store::write_private(std::path::Path::new(&path), content.as_bytes())
        .map_err(|e| format!("Could not write {path}: {e:#}"))?;

    Ok(crate::transfer::ExportResult {
        path,
        bytes: content.len(),
        counts,
        secrets_included: include_secrets,
    })
}

#[tauri::command]
pub async fn preview_import(
    state: State<'_, AppState>,
    path: String,
    passphrase: String,
) -> Result<crate::transfer::MergePlan, String> {
    let content = crate::transfer::read_export_file(&path).map_err(|e| format!("{e:#}"))?;
    let (file, payload, _) =
        crate::transfer::open_export(&content, &passphrase).map_err(|e| format!("{e:#}"))?;
    let data = state.data.lock().await;
    Ok(crate::transfer::plan_merge(&file, &payload, &data))
}

#[tauri::command]
pub async fn import_data(
    state: State<'_, AppState>,
    path: String,
    passphrase: String,
    options: crate::transfer::ImportOptions,
) -> Result<crate::transfer::ImportReport, String> {
    let content = crate::transfer::read_export_file(&path).map_err(|e| format!("{e:#}"))?;
    let (_, payload, export_key) =
        crate::transfer::open_export(&content, &passphrase).map_err(|e| format!("{e:#}"))?;

    // The key is taken before the lock so a locked vault fails without having
    // merged anything into the copy in memory.
    let master = state.key()?;
    let mut data = state.data.lock().await;
    let report = crate::transfer::apply_merge(payload, &export_key, &master, &mut data, &options)
        .map_err(|e| format!("{e:#}"))?;
    save_app_data(&data, &master).map_err(|e| e.to_string())?;
    Ok(report)
}
