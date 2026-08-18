use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::ssh::{connect_ssh, ConnectLogEvent, SshCommand, SshConnectParams};

use super::{connect_security, timeout_pausable, AppState};
use super::resolve::{resolve_auth, resolve_jumps, JumpHopRequest};

// ── SSH ────────────────────────────────────────────────────────

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
) -> Result<String, String> {
    let session_id = Uuid::new_v4().to_string();

    let server = {
        let data = state.data.lock().await;
        data.servers
            .iter()
            .find(|s| s.id == request.server_id)
            .cloned()
            .ok_or_else(|| "Server not found".to_string())?
    };

    let (auth, jumps, timeout_secs, keepalive_secs) = {
        let data = state.data.lock().await;
        let auth = resolve_auth(&data, &state.key()?, &request.auth_type, &request.auth_value)?;
        let jumps = resolve_jumps(&data, &state.key()?, &request.jumps)?;
        let host_timeout = data.servers.iter()
            .find(|s| s.id == request.server_id)
            .and_then(|s| s.connection_timeout);
        (
            auth,
            jumps,
            host_timeout.unwrap_or(data.settings.connection_timeout_secs) as u64,
            data.settings.keepalive_interval_secs,
        )
    };

    let params = SshConnectParams {
        host: server.host,
        port: server.port,
        username: request.username,
        auth,
        initial_cols: request.cols,
        initial_rows: request.rows,
        keepalive_secs,
        jumps,
    };

    let sec = connect_security(&state, &app, Some(request.connect_id.clone()), true).await;
    let waiting = Arc::clone(&sec.waiting);

    let connect_result = timeout_pausable(
        connect_ssh(session_id.clone(), params, request.connect_id.clone(), app.clone(), Arc::clone(&state.ssh_state), sec),
        timeout_secs,
        waiting,
    )
    .await;

    let err_msg = match connect_result {
        Ok(Ok(())) => None,
        Ok(Err(e)) => Some(e.to_string()),
        Err(_) => Some(format!("Connection timed out after {} seconds", timeout_secs)),
    };

    if let Some(ref msg) = err_msg {
        let _ = app.emit(
            &format!("ssh-connect-log:{}", request.connect_id),
            ConnectLogEvent { message: format!("Connection failed: {}", msg), kind: "error".to_string() },
        );
        return Err(msg.clone());
    }

    Ok(session_id)
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
) -> Result<String, String> {
    let session_id = Uuid::new_v4().to_string();

    let (auth, jumps, timeout_secs, keepalive_secs) = {
        let data = state.data.lock().await;
        (
            resolve_auth(&data, &state.key()?, &request.auth_type, &request.auth_value)?,
            resolve_jumps(&data, &state.key()?, &request.jumps)?,
            data.settings.connection_timeout_secs as u64,
            data.settings.keepalive_interval_secs,
        )
    };

    let params = SshConnectParams {
        host: request.host,
        port: request.port,
        username: request.username,
        auth,
        initial_cols: request.cols,
        initial_rows: request.rows,
        keepalive_secs,
        jumps,
    };

    let sec = connect_security(&state, &app, Some(request.connect_id.clone()), true).await;
    let waiting = Arc::clone(&sec.waiting);

    let connect_result = timeout_pausable(
        connect_ssh(session_id.clone(), params, request.connect_id.clone(), app.clone(), Arc::clone(&state.ssh_state), sec),
        timeout_secs,
        waiting,
    ).await;

    let err_msg = match connect_result {
        Ok(Ok(())) => None,
        Ok(Err(e)) => Some(e.to_string()),
        Err(_) => Some(format!("Connection timed out after {} seconds", timeout_secs)),
    };

    if let Some(ref msg) = err_msg {
        let _ = app.emit(
            &format!("ssh-connect-log:{}", request.connect_id),
            ConnectLogEvent { message: format!("Connection failed: {}", msg), kind: "error".to_string() },
        );
        return Err(msg.clone());
    }

    Ok(session_id)
}

#[tauri::command]
pub async fn ssh_send_input(
    state: State<'_, AppState>,
    session_id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let sessions = state.ssh_state.sessions.lock().await;
    let handle = sessions.get(&session_id).ok_or("Session not found")?;
    handle
        .cmd_tx
        .send(SshCommand::Data(data))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn ssh_resize(
    state: State<'_, AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let sessions = state.ssh_state.sessions.lock().await;
    let handle = sessions.get(&session_id).ok_or("Session not found")?;
    handle
        .cmd_tx
        .send(SshCommand::Resize { cols, rows })
        .await
        .map_err(|e| e.to_string())
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
) -> Result<String, String> {
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
) -> Result<(), String> {
    let sessions = state.ssh_state.sessions.lock().await;
    if let Some(handle) = sessions.get(&session_id) {
        let _ = handle.cmd_tx.send(SshCommand::Close).await;
    }
    Ok(())
}
