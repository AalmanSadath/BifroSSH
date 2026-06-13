use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::crypto::{decrypt, encrypt};
use crate::models::*;
use crate::ppk;
use crate::sftp::SftpClientState;
use crate::ssh::{connect_ssh, ConnectLogEvent, SshAuth, SshCommand, SshConnectParams, SshState};
use crate::store::save_app_data;

pub struct AppState {
    pub data: tokio::sync::Mutex<AppData>,
    pub secret_key: [u8; 32],
    pub ssh_state: Arc<SshState>,
    pub sftp_state: Arc<SftpClientState>,
}

// ── Servers ──────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_servers(state: State<'_, AppState>) -> Result<Vec<Server>, String> {
    let data = state.data.lock().await;
    let safe = data.servers.iter().map(|s| Server {
        encrypted_password: s.encrypted_password.as_ref().map(|_| "[stored]".to_string()),
        ..s.clone()
    }).collect();
    Ok(safe)
}

#[tauri::command]
pub async fn save_server(
    state: State<'_, AppState>,
    server: Server,
    password: Option<String>,
) -> Result<Server, String> {
    let mut data = state.data.lock().await;

    let encrypted_password = if let Some(pw) = password.filter(|p| !p.is_empty()) {
        Some(encrypt(pw.as_bytes(), &state.secret_key).map_err(|e| e.to_string())?)
    } else if !server.id.is_empty() {
        data.servers.iter().find(|s| s.id == server.id).and_then(|s| s.encrypted_password.clone())
    } else {
        None
    };

    let encrypted_password = if server.key_id.is_some() { None } else { encrypted_password };

    let server = Server {
        id: if server.id.is_empty() { Uuid::new_v4().to_string() } else { server.id },
        encrypted_password,
        ..server
    };

    match data.servers.iter().position(|s| s.id == server.id) {
        Some(idx) => data.servers[idx] = server.clone(),
        None => data.servers.push(server.clone()),
    }
    save_app_data(&*data).map_err(|e| e.to_string())?;

    Ok(Server {
        encrypted_password: server.encrypted_password.as_ref().map(|_| "[stored]".to_string()),
        ..server
    })
}

#[tauri::command]
pub async fn get_server_password(
    state: State<'_, AppState>,
    server_id: String,
) -> Result<String, String> {
    let data = state.data.lock().await;
    let server = data.servers.iter().find(|s| s.id == server_id).ok_or("Server not found")?;
    let enc = server.encrypted_password.as_ref().ok_or("No password stored for this server")?;
    let bytes = decrypt(enc, &state.secret_key).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|e| e.to_string())
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
    let mut data = state.data.lock().await;
    let mut updated = false;
    for key in data.keys.iter_mut() {
        if key.algorithm.is_none() {
            let pem = if let Some(ref enc) = key.encrypted_key {
                decrypt(enc, &state.secret_key).ok().and_then(|b| String::from_utf8(b).ok())
            } else if let Some(ref path) = key.key_path {
                std::fs::read_to_string(path).ok()
            } else {
                None
            };
            if let Some(ref pem) = pem {
                key.algorithm = detect_algorithm(pem);
                if key.algorithm.is_some() { updated = true; }
            }
        }
    }
    if updated { let _ = save_app_data(&*data); }
    let safe: Vec<KeyEntry> = data.keys.iter().map(|k| KeyEntry {
        id: k.id.clone(),
        name: k.name.clone(),
        key_path: k.key_path.clone(),
        encrypted_key: k.encrypted_key.as_ref().map(|_| "[stored]".to_string()),
        encrypted_passphrase: k.encrypted_passphrase.as_ref().map(|_| "[stored]".to_string()),
        algorithm: k.algorithm.clone(),
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

    let (encrypted_key, algorithm) = if store_content {
        let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let alg = detect_algorithm(&content);
        let enc = encrypt(content.as_bytes(), &state.secret_key).map_err(|e| e.to_string())?;
        (Some(enc), alg)
    } else {
        let content = std::fs::read_to_string(&path).ok();
        let alg = content.as_deref().and_then(detect_algorithm);
        (None, alg)
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
        key_path: if encrypted_key.is_none() { Some(path) } else { None },
        encrypted_key,
        encrypted_passphrase,
        algorithm,
    };
    data.keys.push(key.clone());
    save_app_data(&*data).map_err(|e| e.to_string())?;

    Ok(KeyEntry {
        id: key.id,
        name: key.name,
        key_path: key.key_path,
        encrypted_key: key.encrypted_key.as_ref().map(|_| "[stored]".to_string()),
        encrypted_passphrase: key.encrypted_passphrase.as_ref().map(|_| "[stored]".to_string()),
        algorithm: key.algorithm,
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

    let algorithm = detect_algorithm(&content);
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
        algorithm,
    };
    data.keys.push(key.clone());
    save_app_data(&*data).map_err(|e| e.to_string())?;

    Ok(KeyEntry {
        id: key.id,
        name: key.name,
        key_path: None,
        encrypted_key: Some("[stored]".to_string()),
        encrypted_passphrase: key.encrypted_passphrase.as_ref().map(|_| "[stored]".to_string()),
        algorithm: key.algorithm,
    })
}

#[tauri::command]
pub async fn delete_key(state: State<'_, AppState>, key_id: String) -> Result<(), String> {
    let mut data = state.data.lock().await;
    data.keys.retain(|k| k.id != key_id);
    save_app_data(&*data).map_err(|e| e.to_string())
}

fn detect_algorithm(pem: &str) -> Option<String> {
    if ppk::is_ppk(pem) {
        return ppk::ppk_detect_algorithm(pem);
    }
    if let Ok(k) = ssh_key::PrivateKey::from_openssh(pem) {
        return Some(match k.algorithm() {
            ssh_key::Algorithm::Ed25519 => "ED25519".to_string(),
            ssh_key::Algorithm::Ecdsa { curve } => match curve {
                ssh_key::EcdsaCurve::NistP256 => "ECDSA P-256".to_string(),
                ssh_key::EcdsaCurve::NistP384 => "ECDSA P-384".to_string(),
                ssh_key::EcdsaCurve::NistP521 => "ECDSA P-521".to_string(),
            },
            ssh_key::Algorithm::Rsa { .. } => "RSA".to_string(),
            other => other.to_string(),
        });
    }
    if let Ok(kp) = russh_keys::decode_secret_key(pem, None) {
        return Some(match kp.name() {
            "ssh-ed25519" => "ED25519".to_string(),
            "ssh-rsa" | "rsa-sha2-256" | "rsa-sha2-512" => "RSA".to_string(),
            "ecdsa-sha2-nistp256" => "ECDSA P-256".to_string(),
            "ecdsa-sha2-nistp384" => "ECDSA P-384".to_string(),
            "ecdsa-sha2-nistp521" => "ECDSA P-521".to_string(),
            other => other.to_string(),
        });
    }
    None
}

#[tauri::command]
pub async fn convert_ppk(content: String, passphrase: Option<String>) -> Result<String, String> {
    if !ppk::is_ppk(&content) {
        return Err("Not a PPK file".into());
    }
    ppk::ppk_to_openssh(&content, passphrase.as_deref())
}

fn pem_to_public_openssh(pem: &str, passphrase: Option<&str>) -> Option<String> {
    if let Some(s) = ssh_key::PrivateKey::from_openssh(pem)
        .ok()
        .and_then(|k| k.public_key().to_openssh().ok())
    {
        return Some(s);
    }
    russh_keys::decode_secret_key(pem, passphrase)
        .ok()
        .and_then(|kp| kp.clone_public_key().ok())
        .and_then(|pub_key| {
            let mut buf = Vec::new();
            russh_keys::write_public_key_base64(&mut buf, &pub_key).ok()?;
            String::from_utf8(buf).ok()
        })
}

// ── Key content view ─────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct KeyContent {
    pub private_pem: String,
    pub public_openssh: Option<String>,
}

#[tauri::command]
pub async fn get_key_content(
    state: State<'_, AppState>,
    key_id: String,
) -> Result<KeyContent, String> {
    let data = state.data.lock().await;
    let key = data.keys.iter().find(|k| k.id == key_id)
        .ok_or("Key not found")?;

    let private_pem = if let Some(ref enc) = key.encrypted_key {
        let bytes = decrypt(enc, &state.secret_key).map_err(|e| e.to_string())?;
        String::from_utf8(bytes).map_err(|e| e.to_string())?
    } else if let Some(ref path) = key.key_path {
        std::fs::read_to_string(path).map_err(|e| e.to_string())?
    } else {
        return Err("Key has no content or path".to_string());
    };

    let passphrase = key.encrypted_passphrase.as_ref()
        .and_then(|enc| decrypt(enc, &state.secret_key).ok())
        .and_then(|b| String::from_utf8(b).ok());
    let public_openssh = pem_to_public_openssh(&private_pem, passphrase.as_deref());

    Ok(KeyContent { private_pem, public_openssh })
}

#[tauri::command]
pub async fn update_key(
    state: State<'_, AppState>,
    key_id: String,
    name: String,
    content: String,
    passphrase: Option<String>,
) -> Result<(), String> {
    let mut data = state.data.lock().await;
    let key = data.keys.iter_mut().find(|k| k.id == key_id)
        .ok_or("Key not found")?;
    key.name = name;
    key.algorithm = detect_algorithm(&content);
    key.encrypted_key = Some(encrypt(content.as_bytes(), &state.secret_key).map_err(|e| e.to_string())?);
    key.key_path = None;
    key.encrypted_passphrase = match passphrase {
        Some(ref p) if !p.is_empty() =>
            Some(encrypt(p.as_bytes(), &state.secret_key).map_err(|e| e.to_string())?),
        _ => key.encrypted_passphrase.clone(),
    };
    save_app_data(&*data).map_err(|e| e.to_string())
}

// ── Key generation ───────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct GeneratedKey {
    pub private_pem: String,
    pub public_openssh: String,
}

#[tauri::command]
pub async fn generate_key(algorithm: String) -> Result<GeneratedKey, String> {
    use ssh_key::{Algorithm, EcdsaCurve, LineEnding, PrivateKey};
    use ssh_key::private::{KeypairData, RsaKeypair};
    use rand::rngs::OsRng;

    let mut rng = OsRng;

    let key = match algorithm.as_str() {
        "ed25519" => PrivateKey::random(&mut rng, Algorithm::Ed25519)
            .map_err(|e| e.to_string())?,
        "ecdsa-p256" => PrivateKey::random(&mut rng, Algorithm::Ecdsa { curve: EcdsaCurve::NistP256 })
            .map_err(|e| e.to_string())?,
        "rsa-2048" => {
            let rsa = RsaKeypair::random(&mut rng, 2048).map_err(|e| e.to_string())?;
            PrivateKey::new(KeypairData::Rsa(rsa), "").map_err(|e| e.to_string())?
        }
        "rsa-4096" => {
            let rsa = RsaKeypair::random(&mut rng, 4096).map_err(|e| e.to_string())?;
            PrivateKey::new(KeypairData::Rsa(rsa), "").map_err(|e| e.to_string())?
        }
        _ => return Err(format!("Unknown algorithm: {}", algorithm)),
    };

    let private_pem = key.to_openssh(LineEnding::LF)
        .map_err(|e| e.to_string())?
        .to_string();
    let public_openssh = key.public_key()
        .to_openssh()
        .map_err(|e| e.to_string())?;

    Ok(GeneratedKey { private_pem, public_openssh })
}

// ── Identities ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_identities(state: State<'_, AppState>) -> Result<Vec<Identity>, String> {
    Ok(state.data.lock().await.identities.iter().map(|i| Identity {
        encrypted_password: i.encrypted_password.as_ref().map(|_| "[stored]".to_string()),
        ..i.clone()
    }).collect())
}

#[tauri::command]
pub async fn save_identity(
    state: State<'_, AppState>,
    identity: Identity,
    password: Option<String>,
) -> Result<Identity, String> {
    let mut data = state.data.lock().await;
    let mut identity = if identity.id.is_empty() {
        Identity { id: Uuid::new_v4().to_string(), ..identity }
    } else {
        identity
    };

    if let Some(ref pw) = password {
        identity.encrypted_password = Some(encrypt(pw.as_bytes(), &state.secret_key).map_err(|e| e.to_string())?);
    } else if identity.key_id.is_some() {
        identity.encrypted_password = None;
    } else {
        let existing_pw = data.identities.iter().find(|i| i.id == identity.id)
            .and_then(|i| i.encrypted_password.clone());
        identity.encrypted_password = existing_pw;
    }

    match data.identities.iter().position(|i| i.id == identity.id) {
        Some(idx) => data.identities[idx] = identity.clone(),
        None => data.identities.push(identity.clone()),
    }
    save_app_data(&*data).map_err(|e| e.to_string())?;
    Ok(Identity {
        encrypted_password: identity.encrypted_password.map(|_| "[stored]".to_string()),
        ..identity
    })
}

#[tauri::command]
pub async fn get_identity_password(
    state: State<'_, AppState>,
    identity_id: String,
) -> Result<String, String> {
    let data = state.data.lock().await;
    let identity = data.identities.iter().find(|i| i.id == identity_id)
        .ok_or("Identity not found")?;
    let enc = identity.encrypted_password.as_ref().ok_or("No password stored for this identity")?;
    let bytes = decrypt(enc, &state.secret_key).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|e| e.to_string())
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
    server_id: String,
    username: String,
    auth_type: String,
    auth_value: String,
) -> Result<String, String> {
    let (host, port, auth) = {
        let data = state.data.lock().await;
        let server = data.servers.iter().find(|s| s.id == server_id)
            .ok_or("Server not found")?;

        let auth = if auth_type == "password" {
            SshAuth::Password(auth_value.clone())
        } else {
            let key_entry = data.keys.iter().find(|k| k.id == auth_value)
                .ok_or("Key not found")?;
            let pem = if let Some(ref enc) = key_entry.encrypted_key {
                let bytes = decrypt(enc, &state.secret_key).map_err(|e| e.to_string())?;
                String::from_utf8(bytes).map_err(|e| e.to_string())?
            } else if let Some(ref path) = key_entry.key_path {
                std::fs::read_to_string(path).map_err(|e| e.to_string())?
            } else {
                return Err("Key has no content".to_string());
            };
            let passphrase = if let Some(ref enc) = key_entry.encrypted_passphrase {
                let bytes = decrypt(enc, &state.secret_key).map_err(|e| e.to_string())?;
                Some(String::from_utf8(bytes).map_err(|e| e.to_string())?)
            } else {
                None
            };
            SshAuth::KeyData { key_pem: pem, passphrase }
        };

        (server.host.clone(), server.port, auth)
    };

    let output = crate::ssh::exec_ssh_command(
        &host, port, &username, auth,
        "cat /etc/os-release 2>/dev/null; cat /proc/device-tree/model 2>/dev/null; echo; uname -s",
    )
    .await
    .map_err(|e| e.to_string())?;

    let detected = parse_os_release(&output);

    {
        let mut data = state.data.lock().await;
        if let Some(server) = data.servers.iter_mut().find(|s| s.id == server_id) {
            server.os = detected.clone();
        }
        save_app_data(&*data).map_err(|e| e.to_string())?;
    }

    Ok(detected)
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
    pub connect_id: String,
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

    let timeout_secs = {
        let data = state.data.lock().await;
        let host_timeout = data.servers.iter()
            .find(|s| s.id == request.server_id)
            .and_then(|s| s.connection_timeout);
        host_timeout.unwrap_or(data.settings.connection_timeout_secs) as u64
    };

    let connect_result = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        connect_ssh(session_id.clone(), params, request.connect_id.clone(), app.clone(), Arc::clone(&state.ssh_state)),
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
}

#[tauri::command]
pub async fn ssh_connect_quick(
    state: State<'_, AppState>,
    app: AppHandle,
    request: QuickConnectRequest,
) -> Result<String, String> {
    let session_id = Uuid::new_v4().to_string();

    let auth = if request.auth_type == "password" {
        SshAuth::Password(request.auth_value.clone())
    } else {
        let (key_pem, passphrase) = {
            let data = state.data.lock().await;
            let key_entry = data.keys.iter().find(|k| k.id == request.auth_value)
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

    let timeout_secs = {
        let data = state.data.lock().await;
        data.settings.connection_timeout_secs as u64
    };

    let params = SshConnectParams {
        host: request.host,
        port: request.port,
        username: request.username,
        auth,
        initial_cols: request.cols,
        initial_rows: request.rows,
    };

    let connect_result = tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        connect_ssh(session_id.clone(), params, request.connect_id.clone(), app.clone(), Arc::clone(&state.ssh_state)),
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

// ── SFTP ─────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn sftp_local_home() -> String {
    crate::sftp::get_local_home()
}

#[tauri::command]
pub async fn sftp_list_local(path: String) -> Result<Vec<crate::sftp::FileEntry>, String> {
    crate::sftp::list_local(&path)
}

#[tauri::command]
pub async fn sftp_connect_remote(
    state: State<'_, AppState>,
    server_id: String,
    username: String,
    auth_type: String,
    auth_value: String,
) -> Result<String, String> {
    let (host, port, key_pem, passphrase) = {
        let data = state.data.lock().await;
        let server = data.servers.iter()
            .find(|s| s.id == server_id)
            .ok_or_else(|| "Server not found".to_string())?;
        let host = server.host.clone();
        let port = server.port as u16;

        let (key_pem, passphrase) = if auth_type == "key" {
            match data.keys.iter().find(|k| k.id == auth_value) {
                Some(k) => {
                    let pem = if let Some(ref enc) = k.encrypted_key {
                        decrypt(enc, &state.secret_key).ok()
                            .and_then(|b| String::from_utf8(b).ok())
                    } else if let Some(ref path) = k.key_path {
                        std::fs::read_to_string(path).ok()
                    } else {
                        None
                    };
                    let pass = k.encrypted_passphrase.as_ref()
                        .and_then(|enc| decrypt(enc, &state.secret_key).ok())
                        .and_then(|b| String::from_utf8(b).ok());
                    (pem, pass)
                }
                None => (None, None),
            }
        } else {
            (None, None)
        };

        (host, port, key_pem, passphrase)
    };

    let session_id = Uuid::new_v4().to_string();

    if auth_type == "key" {
        let pem = key_pem.ok_or_else(|| "Key not found or could not be read".to_string())?;
        crate::sftp::connect_sftp(
            &state.sftp_state,
            &session_id,
            &host,
            port,
            &username,
            Some(&pem),
            passphrase.as_deref(),
            None,
        ).await?;
    } else {
        crate::sftp::connect_sftp(
            &state.sftp_state,
            &session_id,
            &host,
            port,
            &username,
            None,
            None,
            Some(&auth_value),
        ).await?;
    }

    Ok(session_id)
}

#[tauri::command]
pub async fn sftp_get_home(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<String, String> {
    crate::sftp::get_remote_home(&state.sftp_state, &session_id).await
}

#[tauri::command]
pub async fn sftp_list_remote(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<Vec<crate::sftp::FileEntry>, String> {
    crate::sftp::list_remote(&state.sftp_state, &session_id, &path).await
}

#[tauri::command]
pub async fn sftp_disconnect_remote(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    crate::sftp::disconnect_sftp(&state.sftp_state, &session_id).await;
    Ok(())
}

#[tauri::command]
pub async fn sftp_upload(
    state: State<'_, AppState>,
    session_id: String,
    local_path: String,
    remote_dir: String,
) -> Result<(), String> {
    crate::sftp::upload_file(&state.sftp_state, &session_id, &local_path, &remote_dir).await
}

#[tauri::command]
pub async fn sftp_download(
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
    local_dir: String,
) -> Result<(), String> {
    crate::sftp::download_file(&state.sftp_state, &session_id, &remote_path, &local_dir).await
}

#[tauri::command]
pub fn sftp_create_local_dir(path: String) -> Result<(), String> {
    crate::sftp::create_local_dir(&path)
}

#[tauri::command]
pub async fn sftp_mkdir(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    crate::sftp::mkdir(&state.sftp_state, &session_id, &path).await
}

#[tauri::command]
pub fn sftp_delete_local(path: String) -> Result<(), String> {
    crate::sftp::delete_local(&path)
}

#[tauri::command]
pub fn sftp_rename_local(old_path: String, new_path: String) -> Result<(), String> {
    crate::sftp::rename_local(&old_path, &new_path)
}

#[tauri::command]
pub async fn sftp_delete_remote(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    crate::sftp::delete_remote(&state.sftp_state, &session_id, &path, is_dir).await
}

#[tauri::command]
pub async fn sftp_rename_remote(
    state: State<'_, AppState>,
    session_id: String,
    old_path: String,
    new_path: String,
) -> Result<(), String> {
    crate::sftp::rename_remote(&state.sftp_state, &session_id, &old_path, &new_path).await
}
