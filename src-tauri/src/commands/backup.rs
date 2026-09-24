use tauri::State;

use crate::store::save_app_data;

use super::CmdResult;
use super::AppState;

// ── Export and import ────────────────────────────────────────────────────────

/// Where an export should land by default. Somewhere the user will find it,
/// which is Downloads if they have one.
#[tauri::command]
pub async fn default_export_dir() -> CmdResult<String> {
    let home = dirs::home_dir().ok_or("Could not find your home directory")?;
    // The platform answer first, since a localised Windows install spells the
    // folder in the user's own language and a Linux one follows XDG.
    let downloads = dirs::download_dir().unwrap_or_else(|| home.join("Downloads"));
    let dir = if downloads.is_dir() { downloads } else { home };
    Ok(dir.to_string_lossy().into_owned())
}

/// Writes text the user asked to keep: a terminal transcript today.
///
/// Private from the moment it exists, like an export: a transcript holds
/// whatever the session printed, which can be anything. Without `overwrite`
/// the refusal is the open itself rather than a prior exists() check, so a
/// symlink appearing between the two cannot be followed.
#[tauri::command]
pub async fn write_text_file(path: String, contents: String, overwrite: bool) -> CmdResult<()> {
    let file = std::path::Path::new(&path);
    let bytes = contents.as_bytes();
    if overwrite {
        crate::store::write_private(file, bytes)
            .map_err(|e| format!("Could not write {path}: {e:#}"))?;
    } else {
        crate::store::write_new_private(file, bytes).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                format!("{path} already exists")
            } else {
                format!("Could not write {path}: {e}")
            }
        })?;
    }
    Ok(())
}

#[tauri::command]
pub async fn export_data(
    state: State<'_, AppState>,
    path: String,
    passphrase: String,
    include_secrets: bool,
    overwrite: bool,
) -> CmdResult<crate::backup::ExportResult> {
    let key = state.key()?;
    let (content, counts) = {
        let data = state.data.lock().await;
        crate::backup::build_export(&data, &key, &passphrase, include_secrets)
            ?
    };

    // Private from the moment it exists, rather than after a chmod a reader
    // could beat. Without overwrite the refusal is the open, not a prior
    // exists() check: that check and the write were two steps, and a symlink
    // appearing between them would have been followed and its target
    // truncated.
    let file = std::path::Path::new(&path);
    let content_bytes = content.as_bytes();
    if overwrite {
        crate::store::write_private(file, content_bytes)
            .map_err(|e| format!("Could not write {path}: {e:#}"))?;
    } else {
        crate::store::write_new_private(file, content_bytes).map_err(|e| {
            if e.kind() == std::io::ErrorKind::AlreadyExists {
                format!("{path} already exists")
            } else {
                format!("Could not write {path}: {e}")
            }
        })?;
    }

    Ok(crate::backup::ExportResult {
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
) -> CmdResult<crate::backup::MergePlan> {
    let content = crate::backup::read_export_file(&path)?;
    let (file, payload, _) =
        crate::backup::open_export(&content, &passphrase)?;
    let data = state.data.lock().await;
    Ok(crate::backup::plan_merge(&file, &payload, &data))
}

#[tauri::command]
pub async fn import_data(
    state: State<'_, AppState>,
    path: String,
    passphrase: String,
    options: crate::backup::ImportOptions,
) -> CmdResult<crate::backup::ImportReport> {
    let content = crate::backup::read_export_file(&path)?;
    let (_, payload, export_key) =
        crate::backup::open_export(&content, &passphrase)?;

    // The key is taken before the lock so a locked vault fails without having
    // merged anything into the copy in memory.
    let master = state.key()?;
    let mut data = state.data.lock().await;
    let report = crate::backup::apply_merge(payload, &export_key, &master, &mut data, &options)?;
    save_app_data(&data, &master)?;
    Ok(report)
}
