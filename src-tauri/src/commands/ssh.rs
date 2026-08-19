use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::connect::ConnectLogEvent;
use crate::ssh::{connect_ssh, SshCommand, SshConnectParams};

use super::{CmdError, CmdResult, connect_security, timeout_pausable, AppState};
use super::resolve::{resolve_auth, resolve_jumps, JumpHopRequest};

// ── SSH ────────────────────────────────────────────────────────

/// What resolving a connection request out of the saved data produces.
struct Prepared {
    auth: crate::ssh::SshAuth,
    jumps: Vec<crate::jump::JumpHop>,
    timeout_secs: u64,
    keepalive_secs: u32,
}

/// Turns the ids in a request into the things they name.
///
/// Synchronous and taking `&AppData`, so the caller decides how long the lock
/// is held; ssh_connect needs the server out of the same lock anyway.
fn prepare(
    data: &crate::models::AppData,
    key: &[u8; 32],
    auth_type: &str,
    auth_value: &str,
    jumps: &[JumpHopRequest],
    host_timeout: Option<u32>,
) -> CmdResult<Prepared> {
    Ok(Prepared {
        auth: resolve_auth(data, key, auth_type, auth_value)?,
        jumps: resolve_jumps(data, key, jumps)?,
        timeout_secs: host_timeout.unwrap_or(data.settings.connection_timeout_secs) as u64,
        keepalive_secs: data.settings.keepalive_interval_secs,
    })
}

/// Opens a session and reports the outcome the way the connect view expects.
///
/// The two connect commands differ only in where the host and port come from
/// and whether the host has a timeout of its own. Everything after that was
/// written out twice, identically, down to the wording of the timeout message
/// and the shape of the log event.
async fn start_session(
    state: &State<'_, AppState>,
    app: &AppHandle,
    connect_id: String,
    params: SshConnectParams,
    timeout_secs: u64,
) -> CmdResult<String> {
    let session_id = Uuid::new_v4().to_string();

    let sec = connect_security(state, app, Some(connect_id.clone()), true).await;
    let waiting = Arc::clone(&sec.waiting);

    let connect_result = timeout_pausable(
        connect_ssh(
            session_id.clone(),
            params,
            connect_id.clone(),
            app.clone(),
            Arc::clone(&state.ssh_state),
            sec,
        ),
        timeout_secs,
        waiting,
    )
    .await;

    let err_msg = match connect_result {
        Ok(Ok(())) => None,
        Ok(Err(e)) => Some(e.to_string()),
        Err(_) => Some(format!("Connection timed out after {} seconds", timeout_secs)),
    };

    if let Some(msg) = err_msg {
        // The connect view is listening on this id and shows nothing otherwise,
        // so the failure has to be narrated as well as returned.
        let _ = app.emit(
            &format!("ssh-connect-log:{}", connect_id),
            ConnectLogEvent {
                message: format!("Connection failed: {}", msg),
                kind: "error".to_string(),
            },
        );
        return Err(msg.into());
    }

    Ok(session_id)
}


#[derive(serde::Deserialize)]
pub struct ConnectRequest {
    pub server_id: String,
    pub username: String,
    pub auth_type: String,
    pub auth_value: String,
    pub cols: u32,
    pub rows: u32,
    pub connect_id: String,
    #[serde(default)]
    pub jumps: Vec<JumpHopRequest>,
}

#[tauri::command]
pub async fn ssh_connect(
    state: State<'_, AppState>,
    app: AppHandle,
    request: ConnectRequest,
) -> CmdResult<String> {
    // One lock: the server, and everything the request names, come out together.
    let (host, port, prep) = {
        let data = state.data.lock().await;
        let server = super::records::find_by_id(&data.servers, &request.server_id)
            .ok_or("Server not found")?;
        let (host, port, host_timeout) =
            (server.host.clone(), server.port, server.connection_timeout);
        let prep = prepare(
            &data,
            &state.key()?,
            &request.auth_type,
            &request.auth_value,
            &request.jumps,
            host_timeout,
        )?;
        (host, port, prep)
    };

    let params = SshConnectParams {
        host,
        port,
        username: request.username,
        auth: prep.auth,
        initial_cols: request.cols,
        initial_rows: request.rows,
        keepalive_secs: prep.keepalive_secs,
        jumps: prep.jumps,
    };

    start_session(&state, &app, request.connect_id, params, prep.timeout_secs).await
}

#[derive(serde::Deserialize)]
pub struct QuickConnectRequest {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub auth_value: String,
    pub cols: u32,
    pub rows: u32,
    pub connect_id: String,
    #[serde(default)]
    pub jumps: Vec<JumpHopRequest>,
}

#[tauri::command]
pub async fn ssh_connect_quick(
    state: State<'_, AppState>,
    app: AppHandle,
    request: QuickConnectRequest,
) -> CmdResult<String> {
    // No saved host, so no host timeout: the global setting is the only one.
    let prep = {
        let data = state.data.lock().await;
        prepare(
            &data,
            &state.key()?,
            &request.auth_type,
            &request.auth_value,
            &request.jumps,
            None,
        )?
    };

    let params = SshConnectParams {
        host: request.host,
        port: request.port,
        username: request.username,
        auth: prep.auth,
        initial_cols: request.cols,
        initial_rows: request.rows,
        keepalive_secs: prep.keepalive_secs,
        jumps: prep.jumps,
    };

    start_session(&state, &app, request.connect_id, params, prep.timeout_secs).await
}

#[tauri::command]
pub async fn ssh_send_input(
    state: State<'_, AppState>,
    session_id: String,
    data: Vec<u8>,
) -> CmdResult<()> {
    let sessions = state.ssh_state.sessions.lock().await;
    let handle = sessions.get(&session_id).ok_or("Session not found")?;
    handle
        .cmd_tx
        .send(SshCommand::Data(data))
        .await
        .map_err(CmdError::from)
}

#[tauri::command]
pub async fn ssh_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> CmdResult<()> {
    let sessions = state.ssh_state.sessions.lock().await;
    let handle = sessions.get(&session_id).ok_or("Session not found")?;
    handle
        .cmd_tx
        .send(SshCommand::Resize { cols, rows })
        .await
        .map_err(CmdError::from)
}

/// Hands over whatever the shell said before the terminal was listening.
///
/// Called once, immediately after the terminal subscribes to this session's
/// output. Everything from here on arrives as events; this is only the part
/// that would otherwise have been emitted into a void.
///
/// A session that has already gone away is not an error: the connection can
/// close between the terminal mounting and this call, and there is nothing to
/// replay in that case.
#[tauri::command]
pub async fn ssh_attach(
    state: State<'_, AppState>,
    session_id: String,
) -> CmdResult<String> {
    let sessions = state.ssh_state.sessions.lock().await;
    let Some(handle) = sessions.get(&session_id) else {
        return Ok(String::new());
    };
    let pending = handle.attach.lock().await.take();
    Ok(BASE64.encode(pending))
}

#[tauri::command]
pub async fn ssh_disconnect(
    state: State<'_, AppState>,
    session_id: String,
) -> CmdResult<()> {
    let sessions = state.ssh_state.sessions.lock().await;
    if let Some(handle) = sessions.get(&session_id) {
        let _ = handle.cmd_tx.send(SshCommand::Close).await;
    }
    Ok(())
}
