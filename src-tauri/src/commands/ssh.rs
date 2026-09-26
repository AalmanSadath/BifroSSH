use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::connect::ConnectLogEvent;
use crate::models::{env_pairs, AuthMethod, DEFAULT_TERM};
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
    auth_type: AuthMethod,
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
    pub auth_type: AuthMethod,
    pub auth_value: String,
    pub cols: u32,
    pub rows: u32,
    pub connect_id: String,
    #[serde(default)]
    pub jumps: Vec<JumpHopRequest>,
}

/// What the saved record contributes to a connection, read under one lock.
///
/// A struct rather than a tuple of ten: every field but two is a `String` or
/// a `bool`, and a tuple that wide is one reordering away from a connection
/// to the right host with the wrong name.
struct Saved {
    host: String,
    port: u16,
    prep: Prepared,
    forward_agent: bool,
    log_to: Option<Option<String>>,
    label: String,
    run_on_connect: Option<String>,
    hide_run_on_connect: bool,
    term: String,
    env: Vec<(String, String)>,
}

#[tauri::command]
pub async fn ssh_connect(
    state: State<'_, AppState>,
    app: AppHandle,
    request: ConnectRequest,
) -> CmdResult<String> {
    // One lock: the server, and everything the request names, come out together.
    let Saved { host, port, prep, forward_agent, log_to, label, run_on_connect, hide_run_on_connect, term, env } = {
        let data = state.data.lock().await;
        let server = super::records::find_by_id(&data.servers, &request.server_id)
            .ok_or("Server not found")?;
        let host_timeout = server.connection_timeout;
        let log_to = server.log_sessions.then(|| data.settings.session_log_dir.clone());
        let prep = prepare(
            &data,
            &state.key()?,
            request.auth_type,
            &request.auth_value,
            &request.jumps,
            host_timeout,
        )?;
        Saved {
            host: server.host.clone(),
            port: server.port,
            prep,
            forward_agent: server.forward_agent,
            log_to,
            label: server.name.clone(),
            run_on_connect: server.run_on_connect.clone().filter(|c| !c.trim().is_empty()),
            hide_run_on_connect: server.hide_run_on_connect,
            term: server.term.clone().filter(|t| !t.trim().is_empty())
                .unwrap_or_else(|| DEFAULT_TERM.to_string()),
            env: server.env.as_deref().map(env_pairs).unwrap_or_default(),
        }
    };

    // The host asks for a log: opened here, before the connect, so the
    // banner and motd land in it. The session id is minted in start_session,
    // so the file is named for the connect id, which is as stable.
    let log = match log_to {
        Some(dir) => {
            let dir = crate::sessionlog::session_log_dir(dir.as_deref())?;
            Some(crate::sessionlog::open_session_log(&dir, &label, &request.connect_id)?.1)
        }
        None => None,
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
        forward_agent,
        log,
        run_on_connect,
        hide_run_on_connect,
        term,
        env,
    };

    start_session(&state, &app, request.connect_id, params, prep.timeout_secs).await
}

#[derive(serde::Deserialize)]
pub struct QuickConnectRequest {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: AuthMethod,
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
            request.auth_type,
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
        // A quick connection has no host record to have said yes on.
        forward_agent: false,
        log: None,
        run_on_connect: None,
        hide_run_on_connect: true,
        term: DEFAULT_TERM.to_string(),
        env: Vec::new(),
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

/// Starts or stops logging a session, and says where the file is.
///
/// `label` names the file; the frontend passes the tab's name, which is
/// what the user knows the session by. Stopping returns None.
#[tauri::command]
pub async fn ssh_set_log(
    state: State<'_, AppState>,
    session_id: String,
    label: String,
    on: bool,
) -> CmdResult<Option<String>> {
    let (file, path) = if on {
        let dir = {
            let data = state.data.lock().await;
            crate::sessionlog::session_log_dir(data.settings.session_log_dir.as_deref())?
        };
        let (path, file) = crate::sessionlog::open_session_log(&dir, &label, &session_id)?;
        (Some(file), Some(path.to_string_lossy().into_owned()))
    } else {
        (None, None)
    };
    let sessions = state.ssh_state.sessions.lock().await;
    let handle = sessions.get(&session_id).ok_or("Session not found")?;
    handle.cmd_tx.send(SshCommand::SetLog(file)).await.map_err(CmdError::from)?;
    Ok(path)
}

/// Starts or stops recording a session as asciicast, and says where the
/// file is. The size is the terminal's now, for the recording's header; a
/// later resize is recorded as it happens. `screen` is what the terminal
/// shows at the start, written as the first event so a playback does not
/// open on a blank screen that only fills in as the host redraws it.
/// Stopping returns None.
#[tauri::command]
pub async fn ssh_set_recording(
    state: State<'_, AppState>,
    session_id: String,
    label: String,
    on: bool,
    cols: u32,
    rows: u32,
    screen: Option<String>,
) -> CmdResult<Option<String>> {
    // Looked up first, so a session that has gone leaves no empty file.
    let cmd_tx = {
        let sessions = state.ssh_state.sessions.lock().await;
        sessions.get(&session_id).ok_or("Session not found")?.cmd_tx.clone()
    };
    let (recorder, path) = if on {
        let dir = {
            let data = state.data.lock().await;
            crate::sessionlog::recording_dir(data.settings.recording_dir.as_deref())?
        };
        let (path, mut recorder) = crate::recording::Recorder::create(&dir, &label, &session_id, cols, rows)?;
        if let Some(screen) = screen.filter(|s| !s.is_empty()) {
            recorder.output(screen.as_bytes()).map_err(anyhow::Error::from)?;
        }
        (Some(recorder), Some(path.to_string_lossy().into_owned()))
    } else {
        (None, None)
    };
    cmd_tx.send(SshCommand::SetRecording(recorder)).await.map_err(CmdError::from)?;
    Ok(path)
}

/// The folder recordings go to, for the Recordings panel to list and the
/// settings page to show.
#[tauri::command]
pub async fn recording_dir(state: State<'_, AppState>) -> CmdResult<String> {
    let data = state.data.lock().await;
    let dir = crate::sessionlog::recording_dir(data.settings.recording_dir.as_deref())?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Opens the file manager on the folder holding `path`, with the file
/// selected, where the platform's file manager can do that.
#[tauri::command]
pub async fn reveal_file(path: String) -> CmdResult<()> {
    // Blocking D-Bus on Linux, so off the async workers.
    tokio::task::spawn_blocking(move || tauri_plugin_opener::reveal_item_in_dir(&path))
        .await
        .map_err(|e| CmdError::from(e.to_string()))?
        .map_err(|e| CmdError::from(format!("Could not show the file: {e}")))
}

/// The folder session logs go to, for the settings page to show.
#[tauri::command]
pub async fn session_log_dir(state: State<'_, AppState>) -> CmdResult<String> {
    let data = state.data.lock().await;
    let dir = crate::sessionlog::session_log_dir(data.settings.session_log_dir.as_deref())?;
    Ok(dir.to_string_lossy().into_owned())
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

/// How long one sample may take before it is abandoned. Well under the bar's
/// three-second interval would starve a slow host; the bar skips a tick while
/// one is still out instead.
const SAMPLE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// One reading of the host a terminal is connected to, for the monitor bar.
///
/// Runs over the terminal's own connection on a channel of its own, so there
/// is no second login and nothing appears in the shell. The sessions lock is
/// released before the command runs: a slow host must not hold up typing.
#[tauri::command]
pub async fn ssh_host_stats(
    state: State<'_, AppState>,
    session_id: String,
) -> CmdResult<crate::hoststats::Sample> {
    let opener = {
        let sessions = state.ssh_state.sessions.lock().await;
        Arc::clone(&sessions.get(&session_id).ok_or("Session not found")?.opener)
    };
    let out = tokio::time::timeout(
        SAMPLE_TIMEOUT,
        crate::sftp::remote_exec::run_capture(&*opener, "the monitor", crate::hoststats::STATS_COMMAND),
    )
    .await
    .map_err(|_| CmdError::from("The host took too long to answer"))??;
    crate::hoststats::parse_sample(&out).map_err(CmdError::from)
}
