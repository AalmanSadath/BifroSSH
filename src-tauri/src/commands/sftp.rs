use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::models::AuthMethod;


use super::{CmdError, CmdResult, connect_security, AppState};
use super::resolve::{JumpHopRequest, server_target};

// ── SFTP ─────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn sftp_local_home() -> String {
    crate::sftp::get_local_home()
}

#[tauri::command]
pub async fn sftp_list_local(path: String) -> CmdResult<Vec<crate::sftp::FileEntry>> {
    crate::sftp::list_local(&path).map_err(CmdError::from)
}

#[tauri::command]
// Tauri commands take their arguments flat off the IPC boundary, so the
// count follows the request shape rather than a choice made here.
#[allow(clippy::too_many_arguments)]
pub async fn sftp_connect_remote(
    state: State<'_, AppState>,
    app: AppHandle,
    server_id: String,
    username: String,
    auth_type: AuthMethod,
    auth_value: String,
    // Channel the connection log is narrated on.
    connect_id: Option<String>,
    jumps: Option<Vec<JumpHopRequest>>,
) -> CmdResult<String> {
    let (target, inactivity_timeout_secs) = {
        let data = state.data.lock().await;
        let target = server_target(
            &data, &state.key()?, &server_id, auth_type, &auth_value, jumps.as_deref(),
        )?;
        (target, data.settings.sftp_inactivity_timeout_secs)
    };

    let session_id = Uuid::new_v4().to_string();
    let sec = connect_security(&state, &app, connect_id, true).await;

    crate::sftp::connect_sftp(
        &state.sftp_state,
        &session_id,
        &target.host,
        target.port,
        &username,
        target.auth,
        inactivity_timeout_secs,
        sec,
        target.jumps,
    ).await?;

    Ok(session_id)
}

#[tauri::command]
pub async fn sftp_get_home(
    state: State<'_, AppState>,
    session_id: String,
) -> CmdResult<String> {
    crate::sftp::get_remote_home(&state.sftp_state, &session_id).await.map_err(CmdError::from)
}

#[tauri::command]
pub async fn sftp_list_remote(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> CmdResult<Vec<crate::sftp::FileEntry>> {
    crate::sftp::list_remote(&state.sftp_state, &session_id, &path).await.map_err(CmdError::from)
}

#[tauri::command]
pub async fn sftp_disconnect_remote(
    state: State<'_, AppState>,
    session_id: String,
) -> CmdResult<()> {
    crate::sftp::disconnect_sftp(&state.sftp_state, &session_id).await;
    Ok(())
}

/// Asks the transfer in flight to stop.
///
/// Returns immediately: the transfer notices at its next chunk boundary and
/// finishes by returning a summary marked cancelled, so the caller that is
/// still awaiting it gets a normal result rather than an error.
#[tauri::command]
pub async fn sftp_cancel_transfer(state: State<'_, AppState>) -> CmdResult<()> {
    state.sftp_state.request_cancel();
    Ok(())
}

#[tauri::command]
pub async fn sftp_upload(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    local_path: String,
    remote_dir: String,
) -> CmdResult<crate::sftp::TransferSummary> {
    crate::sftp::upload_path(&app, &state.sftp_state, &session_id, &local_path, &remote_dir).await.map_err(CmdError::from)
}

#[tauri::command]
pub async fn sftp_download(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
    local_dir: String,
) -> CmdResult<crate::sftp::TransferSummary> {
    crate::sftp::download_path(&app, &state.sftp_state, &session_id, &remote_path, &local_dir).await.map_err(CmdError::from)
}

#[tauri::command]
pub async fn sftp_copy_remote_to_remote(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    src_session_id: String,
    src_path: String,
    dst_session_id: String,
    dst_dir: String,
) -> CmdResult<crate::sftp::TransferSummary> {
    crate::sftp::copy_remote_path(&app, &state.sftp_state, &src_session_id, &src_path, &dst_session_id, &dst_dir).await.map_err(CmdError::from)
}

#[tauri::command]
pub fn sftp_create_local_dir(path: String) -> CmdResult<()> {
    crate::sftp::create_local_dir(&path).map_err(CmdError::from)
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> CmdResult<()> {
    crate::sftp::mkdir(&state.sftp_state, &session_id, &path).await.map_err(CmdError::from)
}

#[tauri::command]
pub fn sftp_delete_local(path: String) -> CmdResult<()> {
    crate::sftp::delete_local(&path).map_err(CmdError::from)
}

#[tauri::command]
pub fn sftp_rename_local(old_path: String, new_path: String) -> CmdResult<()> {
    crate::sftp::rename_local(&old_path, &new_path).map_err(CmdError::from)
}

#[tauri::command]
pub async fn sftp_delete_remote(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> CmdResult<()> {
    crate::sftp::delete_remote(&state.sftp_state, &session_id, &path, is_dir).await.map_err(CmdError::from)
}

#[tauri::command]
pub async fn sftp_rename_remote(
    state: State<'_, AppState>,
    session_id: String,
    old_path: String,
    new_path: String,
) -> CmdResult<()> {
    crate::sftp::rename_remote(&state.sftp_state, &session_id, &old_path, &new_path).await.map_err(CmdError::from)
}
