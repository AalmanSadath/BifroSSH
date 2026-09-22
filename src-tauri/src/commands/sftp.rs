use std::sync::Arc;
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

/// Whether the session still answers, asked after a listing has failed.
///
/// A listing fails for a bad path as readily as for a dead link, and the
/// panel used to treat every failure as the second. One cheap request tells
/// them apart.
#[tauri::command]
pub async fn sftp_probe_remote(
    state: State<'_, AppState>,
    session_id: String,
) -> CmdResult<bool> {
    Ok(crate::sftp::probe_remote(&state.sftp_state, &session_id).await)
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
pub async fn sftp_cancel_transfer(state: State<'_, AppState>, transfer_id: String) -> CmdResult<()> {
    state.sftp_state.request_cancel(&transfer_id);
    Ok(())
}

/// Which side of the app the transfer landed on.
enum Landing<'a> {
    Local,
    Remote(&'a str),
}

/// Reads both copies back and compares them, when the user asked for that.
///
/// Folded in here rather than inside each transfer so there is one place
/// that decides, and so the transfer paths stay about moving bytes. A
/// transfer that left the two trees legitimately different (cancelled,
/// something skipped, a copy kept under another name) is left unverified
/// rather than reported as a mismatch.
async fn verified(
    state: &State<'_, AppState>,
    summary: crate::sftp::TransferSummary,
    source: crate::sftp::Side<'_>,
    landing: Landing<'_>,
) -> CmdResult<crate::sftp::TransferSummary> {
    if !state.data.lock().await.settings.verify_transfers || !crate::sftp::comparable(&summary) {
        return Ok(summary);
    }
    let at = summary.landed.clone().unwrap_or_default();
    let landed = match landing {
        Landing::Local => crate::sftp::Side::Local(&at),
        Landing::Remote(session_id) => crate::sftp::Side::Remote { session_id, path: &at },
    };
    let count = crate::sftp::verify_landing(&state.sftp_state, source, landed)
        .await
        .map_err(CmdError::from)?;
    Ok(crate::sftp::TransferSummary { verified: count, ..summary })
}

#[tauri::command]
pub async fn sftp_upload(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    transfer_id: String,
    session_id: String,
    local_path: String,
    remote_dir: String,
    conflict: crate::sftp::Conflict,
) -> CmdResult<crate::sftp::TransferSummary> {
    let sink = crate::sftp::Tagged { app: &app, transfer_id: transfer_id.clone() };
    let summary = crate::sftp::upload_path(&sink, &state.sftp_state, &transfer_id, &session_id, &local_path, &remote_dir, conflict).await.map_err(CmdError::from)?;
    verified(&state, summary, crate::sftp::Side::Local(&local_path), Landing::Remote(&session_id)).await
}

#[tauri::command]
pub async fn sftp_download(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    transfer_id: String,
    session_id: String,
    remote_path: String,
    local_dir: String,
    conflict: crate::sftp::Conflict,
) -> CmdResult<crate::sftp::TransferSummary> {
    let sink = crate::sftp::Tagged { app: &app, transfer_id: transfer_id.clone() };
    let summary = crate::sftp::download_path(&sink, &state.sftp_state, &transfer_id, &session_id, &remote_path, &local_dir, conflict).await.map_err(CmdError::from)?;
    verified(&state, summary, crate::sftp::Side::Remote { session_id: &session_id, path: &remote_path }, Landing::Local).await
}

#[tauri::command]
// Two sessions, two paths, a policy and an id: the eighth is the id, and
// a params struct for one call would say less than the list does.
#[allow(clippy::too_many_arguments)]
pub async fn sftp_copy_remote_to_remote(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    transfer_id: String,
    src_session_id: String,
    src_path: String,
    dst_session_id: String,
    dst_dir: String,
    conflict: crate::sftp::Conflict,
) -> CmdResult<crate::sftp::TransferSummary> {
    let sink = crate::sftp::Tagged { app: &app, transfer_id: transfer_id.clone() };
    let summary = crate::sftp::copy_remote_path(&sink, &state.sftp_state, &transfer_id, &src_session_id, &src_path, &dst_session_id, &dst_dir, conflict).await.map_err(CmdError::from)?;
    verified(&state, summary, crate::sftp::Side::Remote { session_id: &src_session_id, path: &src_path }, Landing::Remote(&dst_session_id)).await
}

/// Which files a transfer would write over, asked before the user is.
///
/// `kind` names the pairing; the session ids that pairing needs must be
/// present, the others are ignored.
#[tauri::command]
pub async fn sftp_conflicts(
    state: State<'_, AppState>,
    kind: String,
    src_session_id: Option<String>,
    src_path: String,
    dst_session_id: Option<String>,
    dst_dir: String,
) -> CmdResult<Vec<String>> {
    use crate::sftp::Pairing;
    let need = |id: Option<String>| id.ok_or_else(|| CmdError::from("Missing session id"));
    let pairing = match kind.as_str() {
        "upload" => Pairing::Upload { session_id: need(dst_session_id)? },
        "download" => Pairing::Download { session_id: need(src_session_id)? },
        "copy" => Pairing::Copy { src_session_id: need(src_session_id)?, dst_session_id: need(dst_session_id)? },
        other => return Err(CmdError::from(format!("Unknown transfer kind: {other}"))),
    };
    crate::sftp::conflicts_for(&state.sftp_state, pairing, &src_path, &dst_dir).await.map_err(CmdError::from)
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

#[tauri::command]
pub fn sftp_open_local(path: String) -> CmdResult<()> {
    crate::sftp::open_local(&path).map_err(CmdError::from)
}

#[tauri::command]
pub async fn sftp_open_remote(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> CmdResult<()> {
    crate::sftp::open_remote(&app, Arc::clone(&state.sftp_state), session_id, path).await.map_err(CmdError::from)
}

#[tauri::command]
pub fn sftp_set_mode_local(path: String, mode: u32) -> CmdResult<()> {
    crate::sftp::set_mode_local(&path, mode).map_err(CmdError::from)
}

#[tauri::command]
pub async fn sftp_set_mode_remote(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    mode: u32,
) -> CmdResult<()> {
    crate::sftp::set_mode_remote(&state.sftp_state, &session_id, &path, mode).await.map_err(CmdError::from)
}

/// A directory as one compressed stream, unpacked as it arrives. Far
/// fewer round trips than a file-by-file download of the same tree.
#[tauri::command]
pub async fn sftp_download_archive(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    transfer_id: String,
    session_id: String,
    remote_path: String,
    local_dir: String,
    into_name: Option<String>,
) -> CmdResult<crate::sftp::TransferSummary> {
    let sink = crate::sftp::Tagged { app: &app, transfer_id: transfer_id.clone() };
    let summary = crate::sftp::download_archive(&sink, &state.sftp_state, &transfer_id, &session_id, &remote_path, &local_dir, into_name.as_deref())
        .await
        .map_err(CmdError::from)?;
    verified(&state, summary, crate::sftp::Side::Remote { session_id: &session_id, path: &remote_path }, Landing::Local).await
}

/// The same, upwards: this machine tars and the server unpacks.
#[tauri::command]
pub async fn sftp_upload_archive(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    transfer_id: String,
    session_id: String,
    local_path: String,
    remote_dir: String,
    into_name: Option<String>,
) -> CmdResult<crate::sftp::TransferSummary> {
    let sink = crate::sftp::Tagged { app: &app, transfer_id: transfer_id.clone() };
    let summary = crate::sftp::upload_archive(&sink, &state.sftp_state, &transfer_id, &session_id, &local_path, &remote_dir, into_name.as_deref())
        .await
        .map_err(CmdError::from)?;
    verified(&state, summary, crate::sftp::Side::Local(&local_path), Landing::Remote(&session_id)).await
}

/// Between two servers: one tars, the other unpacks, and the bytes pass
/// through here without touching this disk.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn sftp_copy_archive(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    transfer_id: String,
    src_session_id: String,
    src_path: String,
    dst_session_id: String,
    dst_dir: String,
    into_name: Option<String>,
) -> CmdResult<crate::sftp::TransferSummary> {
    let sink = crate::sftp::Tagged { app: &app, transfer_id: transfer_id.clone() };
    let summary = crate::sftp::copy_archive(&sink, &state.sftp_state, &transfer_id, &src_session_id, &src_path, &dst_session_id, &dst_dir, into_name.as_deref())
        .await
        .map_err(CmdError::from)?;
    verified(&state, summary, crate::sftp::Side::Remote { session_id: &src_session_id, path: &src_path }, Landing::Remote(&dst_session_id)).await
}

#[tauri::command]
pub fn sftp_set_owner_local(path: String, user: String, group: String) -> CmdResult<()> {
    crate::sftp::set_owner_local(&path, &user, &group).map_err(CmdError::from)
}

#[tauri::command]
pub async fn sftp_set_owner_remote(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    user: String,
    group: String,
) -> CmdResult<()> {
    crate::sftp::set_owner_remote(&state.sftp_state, &session_id, &path, &user, &group).await.map_err(CmdError::from)
}
