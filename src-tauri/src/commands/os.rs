use tauri::{AppHandle, State};

use crate::store::save_app_data;

use super::{connect_security, AppState};
use super::resolve::{resolve_auth, resolve_jumps, JumpHopRequest};

// ── OS detection ─────────────────────────────────────────────────────────────

fn map_distro_id(id: &str) -> &'static str {
    match id {
        "ubuntu"                                       => "ubuntu",
        "debian"                                       => "debian",
        "fedora"                                       => "fedora",
        "arch" | "manjaro" | "endeavouros" | "garuda"  => "arch",
        "raspbian" | "raspios"                         => "raspberrypi",
        "freebsd"                                      => "freebsd",
        _                                              => "linux",
    }
}

fn parse_os_release(output: &str) -> String {
    let mut id = String::new();
    let mut name = String::new();
    let mut pretty_name = String::new();

    for line in output.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("ID=")          { id          = v.trim_matches('"').to_lowercase(); }
        if let Some(v) = line.strip_prefix("NAME=")        { name        = v.trim_matches('"').to_lowercase(); }
        if let Some(v) = line.strip_prefix("PRETTY_NAME=") { pretty_name = v.trim_matches('"').to_lowercase(); }
    }

    // Raspberry Pi detection — hardware marker or name/pretty_name
    for line in output.lines() {
        let l = line.trim().to_lowercase();
        if l.contains("raspberry pi") { return "raspberrypi".to_string(); }
    }

    if !id.is_empty() {
        return map_distro_id(&id).to_string();
    }
    if name.contains("raspberry") || pretty_name.contains("raspberry") {
        return "raspberrypi".to_string();
    }

    // Fallback: uname -s
    for line in output.lines().rev() {
        match line.trim().to_lowercase().as_str() {
            "darwin"  => return "macos".to_string(),
            "freebsd" => return "freebsd".to_string(),
            _         => {}
        }
    }
    "linux".to_string()
}

#[tauri::command]
pub async fn detect_server_os(
    state: State<'_, AppState>,
    app: AppHandle,
    server_id: String,
    username: String,
    auth_type: String,
    auth_value: String,
    jumps: Option<Vec<JumpHopRequest>>,
) -> Result<String, String> {
    let (host, port, auth, jumps) = {
        let data = state.data.lock().await;
        let server = data.servers.iter().find(|s| s.id == server_id)
            .ok_or("Server not found")?;
        let auth = resolve_auth(&data, &state.key()?, &auth_type, &auth_value)?;
        let jumps = resolve_jumps(&data, &state.key()?, jumps.as_deref().unwrap_or(&[]))?;
        (server.host.clone(), server.port, auth, jumps)
    };

    // Non-interactive: this runs in the background with no UI to prompt from,
    // so an unknown host key fails rather than silently trusting.
    let sec = connect_security(&state, &app, None, false).await;

    let output = crate::ssh::exec_ssh_command(
        &host, port, &username, auth,
        "cat /etc/os-release 2>/dev/null; cat /proc/device-tree/model 2>/dev/null; echo; uname -s",
        sec,
        &jumps,
    )
    .await
    .map_err(|e| e.to_string())?;

    let detected = parse_os_release(&output);

    {
        let mut data = state.data.lock().await;
        if let Some(server) = data.servers.iter_mut().find(|s| s.id == server_id) {
            server.os = detected.clone();
        }
        save_app_data(&data, &state.key()?).map_err(|e| e.to_string())?;
    }

    Ok(detected)
}
