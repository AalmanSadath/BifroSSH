use tauri::{AppHandle, State};
use uuid::Uuid;


use super::{CmdError, CmdResult, connect_security, AppState};
use super::resolve::{resolve_auth, resolve_jumps, JumpHopRequest};

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
    auth_type: String,
    auth_value: String,
    // Channel the connection log is narrated on.
    connect_id: Option<String>,
    jumps: Option<Vec<JumpHopRequest>>,
) -> CmdResult<String> {
    let (host, port, auth, jumps, inactivity_timeout_secs) = {
        let data = state.data.lock().await;
        let server = data.servers.iter()
            .find(|s| s.id == server_id)
            .ok_or_else(|| "Server not found".to_string())?;
        let host = server.host.clone();
        let port = server.port as u16;

        let auth = resolve_auth(&data, &state.key()?, &auth_type, &auth_value)?;
        let jumps = resolve_jumps(&data, &state.key()?, jumps.as_deref().unwrap_or(&[]))?;

        (host, port, auth, jumps, data.settings.sftp_inactivity_timeout_secs)
    };

    let session_id = Uuid::new_v4().to_string();
    let sec = connect_security(&state, &app, connect_id, true).await;

    crate::sftp::connect_sftp(
        &state.sftp_state,
        &session_id,
        &host,
        port,
        &username,
        auth,
        inactivity_timeout_secs,
        sec,
        jumps,
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
