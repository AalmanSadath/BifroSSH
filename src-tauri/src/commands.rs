use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

use crate::crypto::{decrypt, encrypt};
use crate::hostkeys::{self, ConnectSecurity, KnownHostEntry};
use crate::jump::JumpHop;
use crate::models::*;
use crate::ppk;
use crate::prompts::{HostKeyDecision, PromptState};
use crate::sftp::SftpClientState;
use crate::ssh::{connect_ssh, ConnectLogEvent, SshAuth, SshCommand, SshConnectParams, SshState};
use crate::store::save_app_data;
use crate::tunnel::{TunnelKind, TunnelParams, TunnelState};

pub struct AppState {
    pub data: tokio::sync::Mutex<AppData>,
    /// Empty until the vault is open.
    ///
    /// This is what makes the locked state safe rather than merely gated:
    /// every read and every write needs the key, so a command that runs
    /// before unlock fails on the missing key instead of quietly operating on
    /// an empty AppData and saving it over the real one.
    pub secret_key: std::sync::OnceLock<[u8; 32]>,
    /// Set when the keystore could not be opened at all, to be shown on the
    /// unlock screen rather than lost to a terminal nobody is watching.
    pub startup_error: Option<String>,
    pub ssh_state: Arc<SshState>,
    pub sftp_state: Arc<SftpClientState>,
    pub tunnel_state: Arc<TunnelState>,
    pub prompts: Arc<PromptState>,
}

impl AppState {
    /// The master key, or an error while the vault is still locked. Returning
    /// an error rather than panicking means a stray command during unlock is a
    /// message, not a crash.
    pub fn key(&self) -> Result<[u8; 32], String> {
        self.secret_key
            .get()
            .copied()
            .ok_or_else(|| "BifroSSH is locked. Enter your master passphrase first.".to_string())
    }
}

/// Like `tokio::time::timeout`, but the countdown stops while `paused` is set.
///
/// A host key prompt blocks the connect on a human, who may take a minute to
/// compare a fingerprint. Plain `timeout` would kill the connection underneath
/// them and leave the modal pointing at a dead session.
pub(crate) async fn timeout_pausable<F: std::future::Future>(
    fut: F,
    secs: u64,
    paused: Arc<AtomicBool>,
) -> Result<F::Output, ()> {
    tokio::pin!(fut);
    let tick = Duration::from_millis(250);
    let budget = Duration::from_secs(secs);
    let mut elapsed = Duration::ZERO;
    loop {
        tokio::select! {
            out = &mut fut => return Ok(out),
            _ = tokio::time::sleep(tick) => {
                if !paused.load(Ordering::Relaxed) {
                    elapsed += tick;
                    if elapsed >= budget { return Err(()); }
                }
            }
        }
    }
}

/// Builds the per-connect host key context. Never call this while holding
/// `state.data` across an await — see `ssh_connect`.
async fn connect_security(
    state: &State<'_, AppState>,
    app: &AppHandle,
    connect_id: Option<String>,
    interactive: bool,
) -> ConnectSecurity {
    let policy = {
        let data = state.data.lock().await;
        data.settings.host_key_policy.clone()
    };
    ConnectSecurity::new(
        app.clone(),
        Arc::clone(&state.prompts),
        &policy,
        connect_id,
        interactive,
    )
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
        Some(encrypt(pw.as_bytes(), &state.key()?).map_err(|e| e.to_string())?)
    } else if !server.id.is_empty() {
        data.servers.iter().find(|s| s.id == server.id).and_then(|s| s.encrypted_password.clone())
    } else {
        None
    };

    // Keyboard-interactive answers are typed per connection and never stored,
    // so no stale password should linger alongside it.
    let uses_prompts = server.auth_kind.as_deref() == Some("keyboard-interactive");
    let encrypted_password = if server.key_id.is_some() || uses_prompts { None } else { encrypted_password };

    let server = Server {
        id: if server.id.is_empty() { Uuid::new_v4().to_string() } else { server.id },
        encrypted_password,
        ..server
    };

    match data.servers.iter().position(|s| s.id == server.id) {
        Some(idx) => data.servers[idx] = server.clone(),
        None => data.servers.push(server.clone()),
    }
    save_app_data(&*data, &state.key()?).map_err(|e| e.to_string())?;

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
    let bytes = decrypt(enc, &state.key()?).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_server(state: State<'_, AppState>, server_id: String) -> Result<(), String> {
    let mut data = state.data.lock().await;
    data.servers.retain(|s| s.id != server_id);
    save_app_data(&*data, &state.key()?).map_err(|e| e.to_string())
}

// ── Keys ─────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_keys(state: State<'_, AppState>) -> Result<Vec<KeyEntry>, String> {
    let mut data = state.data.lock().await;
    let mut updated = false;
    for key in data.keys.iter_mut() {
        if key.algorithm.is_none() {
            let pem = if let Some(ref enc) = key.encrypted_key {
                decrypt(enc, &state.key()?).ok().and_then(|b| String::from_utf8(b).ok())
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
    if updated { let _ = save_app_data(&*data, &state.key()?); }
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
        let enc = encrypt(content.as_bytes(), &state.key()?).map_err(|e| e.to_string())?;
        (Some(enc), alg)
    } else {
        let content = std::fs::read_to_string(&path).ok();
        let alg = content.as_deref().and_then(detect_algorithm);
        (None, alg)
    };

    let encrypted_passphrase = match passphrase {
        Some(ref p) if !p.is_empty() => {
            Some(encrypt(p.as_bytes(), &state.key()?).map_err(|e| e.to_string())?)
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
    save_app_data(&*data, &state.key()?).map_err(|e| e.to_string())?;

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
    let encrypted_key = encrypt(content.as_bytes(), &state.key()?).map_err(|e| e.to_string())?;

    let encrypted_passphrase = match passphrase {
        Some(ref p) if !p.is_empty() => {
            Some(encrypt(p.as_bytes(), &state.key()?).map_err(|e| e.to_string())?)
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
    save_app_data(&*data, &state.key()?).map_err(|e| e.to_string())?;

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
    save_app_data(&*data, &state.key()?).map_err(|e| e.to_string())
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
    pub passphrase: Option<String>,
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
        let bytes = decrypt(enc, &state.key()?).map_err(|e| e.to_string())?;
        String::from_utf8(bytes).map_err(|e| e.to_string())?
    } else if let Some(ref path) = key.key_path {
        std::fs::read_to_string(path).map_err(|e| e.to_string())?
    } else {
        return Err("Key has no content or path".to_string());
    };

    let master = state.key()?;
    let passphrase = key.encrypted_passphrase.as_ref()
        .and_then(|enc| decrypt(enc, &master).ok())
        .and_then(|b| String::from_utf8(b).ok());
    let public_openssh = pem_to_public_openssh(&private_pem, passphrase.as_deref());

    Ok(KeyContent { private_pem, public_openssh, passphrase })
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
    key.encrypted_key = Some(encrypt(content.as_bytes(), &state.key()?).map_err(|e| e.to_string())?);
    key.key_path = None;
    key.encrypted_passphrase = match passphrase {
        Some(ref p) if !p.is_empty() =>
            Some(encrypt(p.as_bytes(), &state.key()?).map_err(|e| e.to_string())?),
        _ => key.encrypted_passphrase.clone(),
    };
    save_app_data(&*data, &state.key()?).map_err(|e| e.to_string())
}

// ── Key generation ───────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct GeneratedKey {
    pub private_pem: String,
    pub public_openssh: String,
}

#[tauri::command]
pub async fn generate_key(algorithm: String, passphrase: Option<String>) -> Result<GeneratedKey, String> {
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

    let public_openssh = key.public_key()
        .to_openssh()
        .map_err(|e| e.to_string())?;

    let private_pem = match passphrase.as_deref().filter(|p| !p.is_empty()) {
        Some(p) => key.encrypt(&mut rng, p)
            .map_err(|e| e.to_string())?
            .to_openssh(LineEnding::LF)
            .map_err(|e| e.to_string())?
            .to_string(),
        None => key.to_openssh(LineEnding::LF)
            .map_err(|e| e.to_string())?
            .to_string(),
    };

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

    let uses_prompts = identity.auth_kind.as_deref() == Some("keyboard-interactive");
    if uses_prompts {
        // Answered per connection, never stored.
        identity.encrypted_password = None;
        identity.key_id = None;
    } else if let Some(ref pw) = password {
        identity.encrypted_password = Some(encrypt(pw.as_bytes(), &state.key()?).map_err(|e| e.to_string())?);
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
    save_app_data(&*data, &state.key()?).map_err(|e| e.to_string())?;
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
    let bytes = decrypt(enc, &state.key()?).map_err(|e| e.to_string())?;
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
    save_app_data(&*data, &state.key()?).map_err(|e| e.to_string())
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
    save_app_data(&*data, &state.key()?).map_err(|e| e.to_string())
}

// ── ssh_config import ────────────────────────────────────────────────────────

#[tauri::command]
pub async fn scan_ssh_config() -> Result<crate::sshconfig::SshConfigScan, String> {
    crate::sshconfig::scan()
}

#[derive(serde::Serialize)]
pub struct SshConfigImport {
    pub imported: u32,
    pub skipped_existing: u32,
    pub keys_linked: u32,
    pub jumps_linked: u32,
}

/// Creates hosts from selected ssh_config entries.
///
/// An entry whose host, port and username already match a saved server is
/// skipped, so running the import twice does not produce duplicates.
#[tauri::command]
pub async fn import_ssh_config_hosts(
    state: State<'_, AppState>,
    aliases: Vec<String>,
) -> Result<SshConfigImport, String> {
    let scan = crate::sshconfig::scan()?;
    let mut data = state.data.lock().await;
    let mut result = SshConfigImport { imported: 0, skipped_existing: 0, keys_linked: 0, jumps_linked: 0 };
    // ProxyJump names another alias, which may not exist as a server until
    // later in this same loop, so the links are made in a second pass.
    let mut by_alias: HashMap<String, String> = HashMap::new();

    for alias in &aliases {
        let Some(entry) = scan.hosts.iter().find(|h| &h.alias == alias) else { continue };
        let port = entry.port.unwrap_or(22);

        let duplicate = data.servers.iter().any(|s| {
            s.host == entry.hostname
                && s.port == port
                && s.username.as_deref() == entry.user.as_deref()
        });
        if duplicate {
            result.skipped_existing += 1;
            continue;
        }

        // Reference the key by path rather than copying it into the keychain:
        // the file stays where ssh expects it, and no private key is duplicated.
        let key_id = match entry.identity_file.as_ref() {
            Some(path) if std::path::Path::new(path).exists() => {
                let existing = data.keys.iter().find(|k| k.key_path.as_deref() == Some(path.as_str()));
                if let Some(key) = existing {
                    Some(key.id.clone())
                } else {
                    let name = std::path::Path::new(path)
                        .file_name()
                        .map(|n| n.to_string_lossy().into_owned())
                        .unwrap_or_else(|| alias.clone());
                    let algorithm = std::fs::read_to_string(path).ok().and_then(|c| detect_algorithm(&c));
                    let key = KeyEntry {
                        id: Uuid::new_v4().to_string(),
                        name,
                        key_path: Some(path.clone()),
                        encrypted_key: None,
                        encrypted_passphrase: None,
                        algorithm,
                    };
                    let id = key.id.clone();
                    data.keys.push(key);
                    result.keys_linked += 1;
                    Some(id)
                }
            }
            _ => None,
        };

        let id = Uuid::new_v4().to_string();
        by_alias.insert(entry.alias.clone(), id.clone());
        data.servers.push(Server {
            id,
            name: entry.alias.clone(),
            host: entry.hostname.clone(),
            port,
            identity_id: None,
            username: entry.user.clone(),
            encrypted_password: None,
            key_id,
            theme: None,
            os: String::new(),
            connection_timeout: None,
            auth_kind: None,
            proxy_jump: None,
        });
        result.imported += 1;
    }

    // A jump host that was not imported alongside its target cannot be linked
    // to anything, so that host is left as a direct connection rather than
    // pointing at a server that does not exist.
    for alias in &aliases {
        let Some(entry) = scan.hosts.iter().find(|h| &h.alias == alias) else { continue };
        let Some(jump) = entry.proxy_jump.as_deref().and_then(crate::sshconfig::jump_alias) else { continue };
        let Some(jump_id) = by_alias.get(jump) else { continue };
        let Some(server_id) = by_alias.get(alias) else { continue };
        if jump_id == server_id {
            continue; // A host declaring itself its own jump host is a loop.
        }
        let jump_id = jump_id.clone();
        if let Some(server) = data.servers.iter_mut().find(|s| &s.id == server_id) {
            server.proxy_jump = Some(jump_id);
            result.jumps_linked += 1;
        }
    }

    save_app_data(&*data, &state.key()?).map_err(|e| e.to_string())?;
    Ok(result)
}

// ── Export and import ────────────────────────────────────────────────────────

/// Where an export should land by default. Somewhere the user will find it,
/// which is Downloads if they have one.
#[tauri::command]
pub async fn default_export_dir() -> Result<String, String> {
    let home = dirs::home_dir().ok_or("Could not find your home directory")?;
    let downloads = home.join("Downloads");
    let dir = if downloads.is_dir() { downloads } else { home };
    Ok(dir.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn export_data(
    state: State<'_, AppState>,
    path: String,
    passphrase: String,
    include_secrets: bool,
    overwrite: bool,
) -> Result<crate::transfer::ExportResult, String> {
    // Checked before anything is built, so a refusal costs nothing and cannot
    // be mistaken for a write that half happened.
    if !overwrite && std::path::Path::new(&path).exists() {
        return Err(format!("{path} already exists"));
    }

    let key = state.key()?;
    let (content, counts) = {
        let data = state.data.lock().await;
        crate::transfer::build_export(&data, &key, &passphrase, include_secrets)
            .map_err(|e| format!("{e:#}"))?
    };

    // write_private, so the file is owner-only from the moment it exists
    // rather than after a chmod that a reader could beat.
    crate::store::write_private(std::path::Path::new(&path), content.as_bytes())
        .map_err(|e| format!("Could not write {path}: {e:#}"))?;

    Ok(crate::transfer::ExportResult {
        path,
        bytes: content.len(),
        counts,
        secrets_included: include_secrets,
    })
}

#[tauri::command]
pub async fn preview_import(
    state: State<'_, AppState>,
    path: String,
    passphrase: String,
) -> Result<crate::transfer::MergePlan, String> {
    let content = crate::transfer::read_export_file(&path).map_err(|e| format!("{e:#}"))?;
    let (file, payload, _) =
        crate::transfer::open_export(&content, &passphrase).map_err(|e| format!("{e:#}"))?;
    let data = state.data.lock().await;
    Ok(crate::transfer::plan_merge(&file, &payload, &data))
}

#[tauri::command]
pub async fn import_data(
    state: State<'_, AppState>,
    path: String,
    passphrase: String,
    options: crate::transfer::ImportOptions,
) -> Result<crate::transfer::ImportReport, String> {
    let content = crate::transfer::read_export_file(&path).map_err(|e| format!("{e:#}"))?;
    let (_, payload, export_key) =
        crate::transfer::open_export(&content, &passphrase).map_err(|e| format!("{e:#}"))?;

    // The key is taken before the lock so a locked vault fails without having
    // merged anything into the copy in memory.
    let master = state.key()?;
    let mut data = state.data.lock().await;
    let report = crate::transfer::apply_merge(payload, &export_key, &master, &mut data, &options)
        .map_err(|e| format!("{e:#}"))?;
    save_app_data(&*data, &master).map_err(|e| e.to_string())?;
    Ok(report)
}

// ── User collections ─────────────────────────────────────────────────────────
//
// Port forwardings, codeprints and custom themes used to live in webview
// localStorage, where clearing browsing data destroyed them and no backup of
// data.json included them. They are small and always rewritten wholesale by
// the UI, so a get/save pair each is enough.

#[tauri::command]
pub async fn get_port_forwardings(state: State<'_, AppState>) -> Result<Vec<PortForwarding>, String> {
    Ok(state.data.lock().await.port_forwardings.clone())
}

#[tauri::command]
pub async fn save_port_forwardings(
    state: State<'_, AppState>,
    items: Vec<PortForwarding>,
) -> Result<(), String> {
    let mut data = state.data.lock().await;
    data.port_forwardings = items;
    save_app_data(&*data, &state.key()?).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_codeprints(state: State<'_, AppState>) -> Result<Vec<Codeprint>, String> {
    Ok(state.data.lock().await.codeprints.clone())
}

#[tauri::command]
pub async fn save_codeprints(
    state: State<'_, AppState>,
    items: Vec<Codeprint>,
) -> Result<(), String> {
    let mut data = state.data.lock().await;
    data.codeprints = items;
    save_app_data(&*data, &state.key()?).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_custom_themes(
    state: State<'_, AppState>,
) -> Result<std::collections::HashMap<String, serde_json::Value>, String> {
    Ok(state.data.lock().await.custom_themes.clone())
}

#[tauri::command]
pub async fn save_custom_themes(
    state: State<'_, AppState>,
    items: std::collections::HashMap<String, serde_json::Value>,
) -> Result<(), String> {
    let mut data = state.data.lock().await;
    data.custom_themes = items;
    save_app_data(&*data, &state.key()?).map_err(|e| e.to_string())
}

// ── Host keys ────────────────────────────────────────────────────────────────

/// Completes a host key prompt. The connect is parked on the matching oneshot.
#[tauri::command]
pub async fn respond_host_key(
    state: State<'_, AppState>,
    request_id: String,
    decision: String,
) -> Result<(), String> {
    let decision = HostKeyDecision::from_str(&decision)
        .ok_or_else(|| format!("Unknown host key decision: {}", decision))?;

    let sender = state.prompts.host_keys.lock().await.remove(&request_id);
    // A missing entry means the connect already gave up (timeout, or the user
    // closed the session). Nothing to answer, and not an error worth surfacing.
    if let Some(sender) = sender {
        let _ = sender.send(decision);
    }

    Ok(())
}

/// Completes a keyboard-interactive round. `None` cancels the login.
#[tauri::command]
pub async fn respond_auth_prompt(
    state: State<'_, AppState>,
    request_id: String,
    responses: Option<Vec<String>>,
) -> Result<(), String> {
    let sender = state.prompts.auth.lock().await.remove(&request_id);
    // Gone means the connect already gave up; nothing left to answer.
    if let Some(sender) = sender {
        let _ = sender.send(responses);
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub struct AgentKeyInfo {
    pub algorithm: String,
    pub fingerprint: String,
}

/// Keys currently held by the running ssh-agent.
///
/// No comment field: the agent protocol carries one, but russh-keys discards it
/// while parsing, so there is no `user@host` label to show.
#[tauri::command]
pub async fn list_agent_keys() -> Result<Vec<AgentKeyInfo>, String> {
    #[cfg(unix)]
    {
        use russh_keys::agent::client::AgentClient;

        let mut agent = AgentClient::connect_env().await.map_err(|e| {
            format!("Could not reach ssh-agent ({}). Check that an agent is running and SSH_AUTH_SOCK is set.", e)
        })?;

        let identities = agent
            .request_identities()
            .await
            .map_err(|e| format!("Could not list ssh-agent keys: {}", e))?;

        Ok(identities
            .iter()
            .map(|key| AgentKeyInfo {
                algorithm: key.name().to_string(),
                fingerprint: hostkeys::fingerprint(key),
            })
            .collect())
    }
    #[cfg(not(unix))]
    {
        Err("ssh-agent is only supported on Unix".to_string())
    }
}

#[tauri::command]
pub async fn list_known_hosts() -> Result<Vec<KnownHostEntry>, String> {
    hostkeys::list_known_hosts().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn forget_known_host(host: String, port: u16) -> Result<(), String> {
    hostkeys::forget_host(&host, port)
        .map(|_| ())
        .map_err(|e| e.to_string())
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
        save_app_data(&*data, &state.key()?).map_err(|e| e.to_string())?;
    }

    Ok(detected)
}

// ── SSH ───────────────────────────────────────────────────────────────────────

/// Turns the credential the frontend picked into something connectable.
///
/// The frontend decides *which* credential applies (identity or per-host,
/// agent or key or password); this decides what that credential means, which
/// for a key means going to the keychain for the material. Shared by sessions,
/// SFTP, tunnels and jump hosts so all four agree.
fn resolve_auth(
    data: &AppData,
    secret_key: &[u8; 32],
    auth_type: &str,
    auth_value: &str,
) -> Result<SshAuth, String> {
    match auth_type {
        // Nothing is stored: the server asks and the user answers at connect time.
        "keyboard-interactive" => Ok(SshAuth::KeyboardInteractive),
        // auth_value optionally pins one agent key by fingerprint.
        "agent" => Ok(SshAuth::Agent {
            fingerprint: (!auth_value.is_empty()).then(|| auth_value.to_string()),
        }),
        "password" => Ok(SshAuth::Password(auth_value.to_string())),
        _ => {
            let key = data
                .keys
                .iter()
                .find(|k| k.id == auth_value)
                .ok_or_else(|| "Key not found".to_string())?;

            let key_pem = if let Some(enc) = &key.encrypted_key {
                let bytes = decrypt(enc, secret_key).map_err(|e| e.to_string())?;
                String::from_utf8(bytes).map_err(|e| e.to_string())?
            } else if let Some(path) = &key.key_path {
                std::fs::read_to_string(path).map_err(|e| e.to_string())?
            } else {
                return Err("Key has no content or path".to_string());
            };

            let passphrase = match &key.encrypted_passphrase {
                Some(enc) => {
                    let bytes = decrypt(enc, secret_key).map_err(|e| e.to_string())?;
                    Some(String::from_utf8(bytes).map_err(|e| e.to_string())?)
                }
                None => None,
            };

            Ok(SshAuth::KeyData { key_pem, passphrase })
        }
    }
}

/// One jump host as the frontend sends it, outermost first. The chain is
/// walked and its credentials picked on the frontend, which is where the
/// identity and per-host rules already live; only the key material is
/// resolved here.
#[derive(serde::Deserialize)]
pub struct JumpHopRequest {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: String,
    pub auth_value: String,
}

fn resolve_jumps(
    data: &AppData,
    secret_key: &[u8; 32],
    hops: &[JumpHopRequest],
) -> Result<Vec<JumpHop>, String> {
    hops.iter()
        .map(|hop| {
            let auth = resolve_auth(data, secret_key, &hop.auth_type, &hop.auth_value)
                .map_err(|e| format!("Jump host {}: {}", hop.host, e))?;
            Ok(JumpHop {
                host: hop.host.clone(),
                port: hop.port,
                username: hop.username.clone(),
                auth,
            })
        })
        .collect()
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
    app: AppHandle,
    server_id: String,
    username: String,
    auth_type: String,
    auth_value: String,
    // Channel the connection log is narrated on.
    connect_id: Option<String>,
    jumps: Option<Vec<JumpHopRequest>>,
) -> Result<String, String> {
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
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    local_path: String,
    remote_dir: String,
) -> Result<crate::sftp::TransferSummary, String> {
    crate::sftp::upload_path(&app, &state.sftp_state, &session_id, &local_path, &remote_dir).await
}

#[tauri::command]
pub async fn sftp_download(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
    local_dir: String,
) -> Result<crate::sftp::TransferSummary, String> {
    crate::sftp::download_path(&app, &state.sftp_state, &session_id, &remote_path, &local_dir).await
}

#[tauri::command]
pub async fn sftp_copy_remote_to_remote(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    src_session_id: String,
    src_path: String,
    dst_session_id: String,
    dst_dir: String,
) -> Result<crate::sftp::TransferSummary, String> {
    crate::sftp::copy_remote_path(&app, &state.sftp_state, &src_session_id, &src_path, &dst_session_id, &dst_dir).await
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

// ── Tunnel commands ───────────────────────────────────────────────────────────

#[tauri::command]
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


// ── Master key ──────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct VaultStatus {
    pub locked: bool,
    /// No key has ever been made for this profile, so the user picks how it
    /// should be kept before anything is written.
    pub setup_required: bool,
    /// Whether a keyring answered, which decides if the keyring option can be
    /// offered at all.
    pub keyring_available: bool,
    /// The keyring is there and holds our key, but will not open. Distinct
    /// from unavailable: the passphrase is being asked for because of
    /// something the user can undo by unlocking their keyring.
    pub keyring_locked: bool,
    /// Set when the keystore could not be opened at all, in which case no
    /// passphrase will help and the message says why.
    pub error: Option<String>,
}

#[tauri::command]
pub async fn vault_status(state: State<'_, AppState>) -> Result<VaultStatus, String> {
    let locked = state.secret_key.get().is_none();
    let setup_required = locked
        && state.startup_error.is_none()
        && crate::store::get_data_dir()
            .map(|dir| crate::keystore::is_first_run(&dir))
            .unwrap_or(false);

    // Only worth the D-Bus round trip while something is going to be said
    // about it, which is the setup screen and the unlock screen.
    let keyring = if locked {
        crate::keystore::keyring_status()
    } else {
        crate::keystore::KeyringStatus::Missing
    };
    Ok(VaultStatus {
        locked,
        setup_required,
        keyring_available: matches!(keyring, crate::keystore::KeyringStatus::Ready(_)),
        keyring_locked: matches!(keyring, crate::keystore::KeyringStatus::Locked),
        error: state.startup_error.clone(),
    })
}

/// A fresh word phrase for the dice button. Generated in the backend so the
/// randomness comes from the same source as the keys themselves.
#[tauri::command]
pub async fn generate_passphrase() -> Result<String, String> {
    Ok(crate::keystore::generate_passphrase())
}

/// Creates the master key the way the first run screen asked for.
#[tauri::command]
pub async fn initialize_vault(
    mode: crate::keystore::InitMode,
    passphrase: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if state.secret_key.get().is_some() {
        return Err("This profile already has a key".to_string());
    }
    let dir = crate::store::get_data_dir().map_err(|e| e.to_string())?;
    if !crate::keystore::is_first_run(&dir) {
        return Err("This profile already has a key".to_string());
    }
    let key = crate::keystore::initialize(&dir, mode, &passphrase).map_err(|e| format!("{e:#}"))?;
    let _ = state.secret_key.set(key);
    Ok(())
}

/// Opens the vault and loads the data that could not be read until now.
#[tauri::command]
pub async fn unlock_vault(passphrase: String, state: State<'_, AppState>) -> Result<(), String> {
    if state.secret_key.get().is_some() {
        return Ok(());
    }
    let dir = crate::store::get_data_dir().map_err(|e| e.to_string())?;
    let key = crate::keystore::unlock_with_passphrase(&dir, &passphrase)
        .map_err(|e| format!("{e:#}"))?;

    // Load before publishing the key, so a data file that will not open leaves
    // the app locked rather than half started with an empty AppData that the
    // next save would write over the real one.
    let loaded = crate::store::load_app_data(&key).map_err(|e| format!("{e:#}"))?;
    *state.data.lock().await = loaded;
    let _ = state.secret_key.set(key);
    Ok(())
}

#[derive(serde::Serialize)]
pub struct KeystoreStatus {
    pub source: crate::keystore::KeySource,
    pub passphrase_set: bool,
    /// When set, the keyring is not allowed to open the vault and the
    /// passphrase is demanded at every launch.
    pub always_ask: bool,
    /// Whether a keyring answered just now. Distinct from `source`, which is
    /// how the key was found at startup: a keyring can appear or disappear
    /// between launches.
    pub keyring_available: bool,
    /// Present but locked, which is the user's to fix and not a fault here.
    pub keyring_locked: bool,
}

#[tauri::command]
pub async fn keystore_status(_state: State<'_, AppState>) -> Result<KeystoreStatus, String> {
    let dir = crate::store::get_data_dir().map_err(|e| e.to_string())?;
    let keyring = crate::keystore::keyring_status();
    let keyring_available = matches!(keyring, crate::keystore::KeyringStatus::Ready(_));
    Ok(KeystoreStatus {
        source: crate::keystore::current_source(&dir, keyring_available),
        keyring_locked: matches!(keyring, crate::keystore::KeyringStatus::Locked),
        passphrase_set: crate::keystore::has_passphrase(&dir),
        always_ask: crate::keystore::always_asks(&dir),
        keyring_available,
    })
}

/// Adds a passphrase and removes .secret. With `always_ask` the keyring copy
/// goes too. Takes effect at the next launch, since the key is already in
/// memory for this one.
#[tauri::command]
pub async fn set_master_passphrase(
    passphrase: String,
    always_ask: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let dir = crate::store::get_data_dir().map_err(|e| e.to_string())?;
    let form = crate::keystore::detect_form(&passphrase);
    crate::keystore::set_passphrase(&dir, &state.key()?, &passphrase, always_ask, form)
        .map_err(|e| format!("{e:#}"))
}

/// Switches between the keyring being allowed to open the vault and the
/// passphrase being required every time.
#[tauri::command]
pub async fn set_always_ask(
    always_ask: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let dir = crate::store::get_data_dir().map_err(|e| e.to_string())?;
    crate::keystore::set_always_ask(&dir, &state.key()?, always_ask)
        .map_err(|e| format!("{e:#}"))
}

/// Requires the current passphrase, so that someone at an unlocked screen
/// cannot quietly turn the protection off.
#[tauri::command]
pub async fn remove_master_passphrase(
    passphrase: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let dir = crate::store::get_data_dir().map_err(|e| e.to_string())?;
    let key = crate::keystore::unlock_with_passphrase(&dir, &passphrase)
        .map_err(|e| format!("{e:#}"))?;
    if key != state.key()? {
        return Err("That passphrase does not match this keystore".to_string());
    }
    crate::keystore::clear_passphrase(&dir, &state.key()?).map_err(|e| format!("{e:#}"))
}
