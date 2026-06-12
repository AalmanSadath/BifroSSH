use std::sync::Arc;
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::crypto::{decrypt, encrypt};
use crate::models::*;
use crate::ssh::{connect_ssh, SshAuth, SshCommand, SshConnectParams, SshState};
use crate::store::save_app_data;

pub struct AppState {
    pub data: tokio::sync::Mutex<AppData>,
    pub secret_key: [u8; 32],
    pub ssh_state: Arc<SshState>,
}

// ── Servers ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_servers(state: State<'_, AppState>) -> Result<Vec<Server>, String> {
    Ok(state.data.lock().await.servers.clone())
}

#[tauri::command]
pub async fn save_server(state: State<'_, AppState>, server: Server) -> Result<Server, String> {
    let mut data = state.data.lock().await;
    let server = if server.id.is_empty() {
        Server { id: Uuid::new_v4().to_string(), ..server }
    } else {
        server
    };
    match data.servers.iter().position(|s| s.id == server.id) {
        Some(idx) => data.servers[idx] = server.clone(),
        None => data.servers.push(server.clone()),
    }
    save_app_data(&*data).map_err(|e| e.to_string())?;
    Ok(server)
}

#[tauri::command]
pub async fn delete_server(state: State<'_, AppState>, server_id: String) -> Result<(), String> {
    let mut data = state.data.lock().await;
    data.servers.retain(|s| s.id != server_id);
    save_app_data(&*data).map_err(|e| e.to_string())
}

// ── Keys ─────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_keys(state: State<'_, AppState>) -> Result<Vec<KeyEntry>, String> {
    let data = state.data.lock().await;
    let safe: Vec<KeyEntry> = data.keys.iter().map(|k| KeyEntry {
        id: k.id.clone(),
        name: k.name.clone(),
        key_path: k.key_path.clone(),
        encrypted_key: k.encrypted_key.as_ref().map(|_| "[stored]".to_string()),
        encrypted_passphrase: k.encrypted_passphrase.as_ref().map(|_| "[stored]".to_string()),
    }).collect();
    Ok(safe)
}

#[tauri::command]
pub async fn import_key_from_path(
    state: State<'_, AppState>,
    name: String,
    path: String,
    passphrase: Option<String>,
    store_content: bool,
) -> Result<KeyEntry, String> {
    let mut data = state.data.lock().await;

    let encrypted_key = if store_content {
        let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        Some(encrypt(content.as_bytes(), &state.secret_key).map_err(|e| e.to_string())?)
    } else {
        None
    };

    let encrypted_passphrase = match passphrase {
        Some(ref p) if !p.is_empty() => {
            Some(encrypt(p.as_bytes(), &state.secret_key).map_err(|e| e.to_string())?)
        }
        _ => None,
    };

    let key = KeyEntry {
        id: Uuid::new_v4().to_string(),
        name,
        key_path: if !store_content { Some(path) } else { None },
        encrypted_key,
        encrypted_passphrase,
    };
    data.keys.push(key.clone());
    save_app_data(&*data).map_err(|e| e.to_string())?;

    Ok(KeyEntry {
        id: key.id,
        name: key.name,
        key_path: key.key_path,
        encrypted_key: key.encrypted_key.as_ref().map(|_| "[stored]".to_string()),
        encrypted_passphrase: key.encrypted_passphrase.as_ref().map(|_| "[stored]".to_string()),
    })
}

#[tauri::command]
pub async fn save_key_from_content(
    state: State<'_, AppState>,
    name: String,
    content: String,
    passphrase: Option<String>,
) -> Result<KeyEntry, String> {
    let mut data = state.data.lock().await;

    let encrypted_key = encrypt(content.as_bytes(), &state.secret_key).map_err(|e| e.to_string())?;

    let encrypted_passphrase = match passphrase {
        Some(ref p) if !p.is_empty() => {
            Some(encrypt(p.as_bytes(), &state.secret_key).map_err(|e| e.to_string())?)
        }
        _ => None,
    };

    let key = KeyEntry {
        id: Uuid::new_v4().to_string(),
        name,
        key_path: None,
        encrypted_key: Some(encrypted_key),
        encrypted_passphrase,
    };
    data.keys.push(key.clone());
    save_app_data(&*data).map_err(|e| e.to_string())?;

    Ok(KeyEntry {
        id: key.id,
        name: key.name,
        key_path: None,
        encrypted_key: Some("[stored]".to_string()),
        encrypted_passphrase: key.encrypted_passphrase.as_ref().map(|_| "[stored]".to_string()),
    })
}

#[tauri::command]
pub async fn delete_key(state: State<'_, AppState>, key_id: String) -> Result<(), String> {
    let mut data = state.data.lock().await;
    data.keys.retain(|k| k.id != key_id);
    save_app_data(&*data).map_err(|e| e.to_string())
}

// ── Identities ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_identities(state: State<'_, AppState>) -> Result<Vec<Identity>, String> {
    Ok(state.data.lock().await.identities.clone())
}

#[tauri::command]
pub async fn save_identity(
    state: State<'_, AppState>,
    identity: Identity,
) -> Result<Identity, String> {
    let mut data = state.data.lock().await;
    let identity = if identity.id.is_empty() {
        Identity { id: Uuid::new_v4().to_string(), ..identity }
    } else {
        identity
    };
    match data.identities.iter().position(|i| i.id == identity.id) {
        Some(idx) => data.identities[idx] = identity.clone(),
        None => data.identities.push(identity.clone()),
    }
    save_app_data(&*data).map_err(|e| e.to_string())?;
    Ok(identity)
}

#[tauri::command]
pub async fn delete_identity(
    state: State<'_, AppState>,
    identity_id: String,
) -> Result<(), String> {
    let mut data = state.data.lock().await;
    data.identities.retain(|i| i.id != identity_id);
    for server in data.servers.iter_mut() {
        if server.identity_id.as_deref() == Some(&identity_id) {
            server.identity_id = None;
        }
    }
    save_app_data(&*data).map_err(|e| e.to_string())
}

// ── Settings ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    Ok(state.data.lock().await.settings.clone())
}

#[tauri::command]
pub async fn save_settings(
    state: State<'_, AppState>,
    settings: Settings,
) -> Result<(), String> {
    let mut data = state.data.lock().await;
    data.settings = settings;
    save_app_data(&*data).map_err(|e| e.to_string())
}

// ── SSH ───────────────────────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
pub struct ConnectRequest {
    pub server_id: String,
    pub username: String,
    pub auth_type: String,
    pub auth_value: String,
    pub cols: u32,
    pub rows: u32,
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

    let auth = if request.auth_type == "password" {
        SshAuth::Password(request.auth_value.clone())
    } else {
        let (key_pem, passphrase) = {
            let data = state.data.lock().await;
            let key_entry = data
                .keys
                .iter()
                .find(|k| k.id == request.auth_value)
                .cloned()
                .ok_or_else(|| "Key not found".to_string())?;

            let pem = if let Some(ref enc) = key_entry.encrypted_key {
                let bytes = decrypt(enc, &state.secret_key).map_err(|e| e.to_string())?;
                String::from_utf8(bytes).map_err(|e| e.to_string())?
            } else if let Some(ref path) = key_entry.key_path {
                std::fs::read_to_string(path).map_err(|e| e.to_string())?
            } else {
                return Err("Key has no content or path".to_string());
            };

            let pass = if let Some(ref enc) = key_entry.encrypted_passphrase {
                let bytes = decrypt(enc, &state.secret_key).map_err(|e| e.to_string())?;
                Some(String::from_utf8(bytes).map_err(|e| e.to_string())?)
            } else {
                None
            };

            (pem, pass)
        };
        SshAuth::KeyData { key_pem, passphrase }
    };

    let params = SshConnectParams {
        host: server.host,
        port: server.port,
        username: request.username,
        auth,
        initial_cols: request.cols,
        initial_rows: request.rows,
    };

    connect_ssh(session_id.clone(), params, app, Arc::clone(&state.ssh_state))
        .await
        .map_err(|e| e.to_string())?;

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
