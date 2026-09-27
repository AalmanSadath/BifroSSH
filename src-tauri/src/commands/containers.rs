use std::sync::Arc;
use std::time::Duration;

use russh::Disconnect;
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::containers::{self, Action, Connection, Engine, Listing, Sudo};
use crate::models::AuthMethod;

use super::resolve::{server_target, JumpHopRequest};
use super::{connect_security, timeout_pausable, AppState, CmdError, CmdResult};

/// How long a listing or an action may take. `docker stop` waits ten seconds
/// for a container to exit before killing it, so this has room above that.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);

/// Connects the Containers panel to a saved host and returns the id its
/// later calls name the connection by.
///
/// A connection of its own, like the SFTP panel's, so it works with no
/// terminal open. It closes after the SFTP idle timeout like that one does,
/// and the panel offers to connect again.
// The request shape, the same as sftp_connect_remote.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn containers_connect(
    state: State<'_, AppState>,
    app: AppHandle,
    server_id: String,
    username: String,
    auth_type: AuthMethod,
    auth_value: String,
    connect_id: Option<String>,
    jumps: Option<Vec<JumpHopRequest>>,
) -> CmdResult<String> {
    let (target, idle_secs) = {
        let data = state.data.lock().await;
        let target = server_target(&data, &state.key()?, &server_id, &username, auth_type, &auth_value, jumps.as_deref())?;
        (target, data.settings.sftp_inactivity_timeout_secs)
    };
    let sec = connect_security(&state, &app, connect_id, true).await;
    let waiting = Arc::clone(&sec.waiting);
    sec.log("auth", &format!("Connecting to \"{}\" port \"{}\" for its containers", target.host, target.port));

    let handle = timeout_pausable(
        crate::ssh::connect_authenticated(
            &target.host,
            target.port,
            &username,
            &target.auth,
            &sec,
            &target.jumps,
            target.proxy.as_ref(),
            Some(Duration::from_secs(idle_secs as u64)),
        ),
        30,
        waiting,
    )
    .await
    .map_err(|_| CmdError::from("Connection timed out after 30 seconds"))??;

    // A new connection starts without sudo, whatever an earlier one had.
    state.container_state.sudo.lock().await.remove(&server_id);
    let id = Uuid::new_v4().to_string();
    state
        .container_state
        .connections
        .lock()
        .await
        .insert(id.clone(), Connection { handle: Arc::new(handle), server_id });
    Ok(id)
}

type Handle = Arc<russh::client::Handle<crate::hostverify::VerifyingHandler>>;

/// The connection, and the server it is to.
async fn connection(state: &State<'_, AppState>, conn_id: &str) -> CmdResult<(Handle, String)> {
    let conns = state.container_state.connections.lock().await;
    let conn = conns.get(conn_id).ok_or("Not connected")?;
    if conn.handle.is_closed() {
        return Err("The connection to the host has closed".into());
    }
    Ok((Arc::clone(&conn.handle), conn.server_id.clone()))
}

/// The sudo held for the connection's host, if it is on.
async fn sudo_for(state: &State<'_, AppState>, server_id: &str) -> Option<Arc<Sudo>> {
    state.container_state.sudo.lock().await.get(server_id).cloned()
}

async fn exec_as_root(handle: &Handle, sudo: &Sudo, command: &str) -> CmdResult<String> {
    exec(handle, &sudo.wrap(command), sudo.input().as_deref().map(Vec::as_slice)).await
}

async fn exec(handle: &Handle, command: &str, input: Option<&[u8]>) -> CmdResult<String> {
    tokio::time::timeout(
        COMMAND_TIMEOUT,
        crate::sftp::remote_exec::run_capture_with_input(&**handle, "the container engine", command, input),
    )
    .await
    .map_err(|_| CmdError::from("The host took too long to answer"))?
    .map_err(CmdError::from)
}

/// Turns sudo on for the panel's host: listings, actions and container tabs
/// run as root from here until it is turned off, the panel disconnects or
/// the app locks.
///
/// Checked before anything is kept. A host that lets the user in without a
/// password needs none, and `password` is ignored; otherwise the password
/// has to get `sudo -k true` through, or it is refused with sudo's reason.
/// It is kept in this process only, and never handed back.
#[tauri::command]
pub async fn containers_sudo_on(state: State<'_, AppState>, conn_id: String, password: Option<String>) -> CmdResult<()> {
    let password = password.map(zeroize::Zeroizing::new);
    let (handle, server_id) = connection(&state, &conn_id).await?;
    let sudo = if exec(&handle, containers::SUDO_CHECK_NO_PASSWORD, None).await.is_ok() {
        Sudo::NoPassword
    } else {
        let Some(password) = password.filter(|p| !p.is_empty()) else {
            return Err("sudo on this host needs your password".into());
        };
        let sudo = Sudo::Password(password);
        exec(&handle, containers::SUDO_CHECK_PASSWORD, sudo.input().as_deref().map(Vec::as_slice))
            .await
            .map_err(|e| CmdError::from(sudo_refusal(&e.to_string())))?;
        sudo
    };
    state.container_state.sudo.lock().await.insert(server_id, Arc::new(sudo));
    Ok(())
}

/// What sudo said when it refused, as the reason to show.
fn sudo_refusal(error: &str) -> String {
    let lower = error.to_lowercase();
    if lower.contains("incorrect password") || lower.contains("sorry, try again") {
        "sudo refused the password".into()
    } else if lower.contains("not in the sudoers") || lower.contains("not allowed") {
        "This user may not use sudo on this host".into()
    } else {
        format!("sudo failed: {error}")
    }
}

#[tauri::command]
pub async fn containers_sudo_off(state: State<'_, AppState>, conn_id: String) -> CmdResult<()> {
    let (_, server_id) = connection(&state, &conn_id).await?;
    state.container_state.sudo.lock().await.remove(&server_id);
    Ok(())
}

/// Every container the user can see and, with sudo on, root's as well,
/// each marked with whose it is.
#[tauri::command]
pub async fn containers_list(state: State<'_, AppState>, conn_id: String) -> CmdResult<Listing> {
    let (handle, server_id) = connection(&state, &conn_id).await?;
    let user = containers::parse_side(&exec(&handle, containers::LIST_COMMAND, None).await?, false)
        .map_err(CmdError::from)?;
    let root = match sudo_for(&state, &server_id).await {
        Some(sudo) => Some(
            containers::parse_side(&exec_as_root(&handle, &sudo, containers::LIST_COMMAND).await?, true)
                .map_err(CmdError::from)?,
        ),
        None => None,
    };
    containers::merge(user, root).map_err(CmdError::from)
}

#[tauri::command]
pub async fn containers_action(
    state: State<'_, AppState>,
    conn_id: String,
    engine: Engine,
    id: String,
    action: Action,
    root: bool,
) -> CmdResult<()> {
    let command = containers::action_command(engine, &id, action).map_err(CmdError::from)?;
    let (handle, server_id) = connection(&state, &conn_id).await?;
    // Root's container, root's action; the user's own run as the user.
    if root {
        let sudo = sudo_for(&state, &server_id)
            .await
            .ok_or("sudo is no longer on for this host. Turn it on again to change root's containers.")?;
        exec_as_root(&handle, &sudo, &command).await.map(|_| ())
    } else {
        exec(&handle, &command, None).await.map(|_| ())
    }
}

#[tauri::command]
pub async fn containers_disconnect(state: State<'_, AppState>, conn_id: String) -> CmdResult<()> {
    let removed = state.container_state.connections.lock().await.remove(&conn_id);
    if let Some(conn) = removed {
        // Sudo goes with the panel's connection; a container tab opened
        // with it cannot be reopened with it afterwards.
        state.container_state.sudo.lock().await.remove(&conn.server_id);
        let _ = conn.handle.disconnect(Disconnect::ByApplication, "", "en").await;
    }
    Ok(())
}
