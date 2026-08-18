use std::sync::Arc;
use tauri::{AppHandle, State};

use crate::tunnel::{TunnelKind, TunnelParams};

use super::{connect_security, AppState};
use super::resolve::{resolve_auth, resolve_jumps, JumpHopRequest};

// ── Tunnel commands ───────────────────────────────────────────────────────────

#[tauri::command]
// Tauri commands take their arguments flat off the IPC boundary, so the
// count follows the request shape rather than a choice made here.
#[allow(clippy::too_many_arguments)]
pub async fn tunnel_start(
    state: State<'_, AppState>,
    app: AppHandle,
    pf_id: String,
    pf_type: String,
    bind_address: String,
    local_port: Option<u32>,
    remote_port: Option<u32>,
    dest_host: Option<String>,
    dest_port: Option<u32>,
    server_id: String,
    username: String,
    auth_type: String,
    auth_value: String,
    jumps: Option<Vec<JumpHopRequest>>,
) -> Result<(), String> {
    let (ssh_host, ssh_port, auth, jumps) = {
        let data = state.data.lock().await;
        let server = data.servers.iter().find(|s| s.id == server_id)
            .ok_or("Server not found")?;
        let auth = resolve_auth(&data, &state.key()?, &auth_type, &auth_value)?;
        let jumps = resolve_jumps(&data, &state.key()?, jumps.as_deref().unwrap_or(&[]))?;
        (server.host.clone(), server.port as u16, auth, jumps)
    };

    // Check not already running
    {
        let tunnels = state.tunnel_state.tunnels.lock().await;
        if tunnels.contains_key(&pf_id) {
            return Err("Tunnel already running".to_string());
        }
    }

    let kind = match pf_type.as_str() {
        "local" => TunnelKind::Local {
            local_port: local_port.ok_or("local_port required")?,
            dest_host: dest_host.ok_or("dest_host required")?,
            dest_port: dest_port.ok_or("dest_port required")?,
        },
        "remote" => TunnelKind::Remote {
            remote_port: remote_port.ok_or("remote_port required")?,
            dest_host: dest_host.ok_or("dest_host required")?,
            dest_port: dest_port.ok_or("dest_port required")?,
        },
        "dynamic" => TunnelKind::Dynamic {
            local_port: local_port.ok_or("local_port required")?,
        },
        t => return Err(format!("Unknown tunnel type: {}", t)),
    };

    let sec = connect_security(&state, &app, None, true).await;
    let keepalive_secs = { state.data.lock().await.settings.keepalive_interval_secs };
    let params = TunnelParams { kind, bind_address, ssh_host, ssh_port, ssh_username: username, auth, sec, keepalive_secs, jumps };

    crate::tunnel::start_tunnel(pf_id, params, Arc::clone(&state.tunnel_state))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn tunnel_stop(
    state: State<'_, AppState>,
    pf_id: String,
) -> Result<(), String> {
    let mut tunnels = state.tunnel_state.tunnels.lock().await;
    if let Some(handle) = tunnels.remove(&pf_id) {
        let _ = handle.stop_tx.send(());
    }
    Ok(())
}
