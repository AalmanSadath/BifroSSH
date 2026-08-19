use tauri::State;
use uuid::Uuid;

use crate::models::*;
use crate::ppk;

use super::records::*;
use super::{CmdError, CmdResult};
use super::AppState;

// ── Keys ─────────────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_keys(state: State<'_, AppState>) -> CmdResult<Vec<KeyEntry>> {
    let mut data = state.data.lock().await;
    let mut updated = false;
    for key in data.keys.iter_mut() {
        if key.algorithm.is_none() {
            let pem = if let Some(ref enc) = key.encrypted_key {
                state.decrypt_str(enc).ok()
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
    if updated { let _ = state.save(&data); }
    Ok(data.keys.iter().cloned().map(Redacted::redacted).collect())
}

#[tauri::command]
pub async fn import_key_from_path(
    state: State<'_, AppState>,
    name: String,
    path: String,
    passphrase: Option<String>,
    store_content: bool,
) -> CmdResult<KeyEntry> {
    let mut data = state.data.lock().await;

    let (encrypted_key, algorithm) = if store_content {
        let content = std::fs::read_to_string(&path)?;
        let alg = detect_algorithm(&content);
        let enc = state.encrypt(content.as_bytes())?;
        (Some(enc), alg)
    } else {
        let content = std::fs::read_to_string(&path).ok();
        let alg = content.as_deref().and_then(detect_algorithm);
        (None, alg)
    };

    let encrypted_passphrase = match passphrase {
        Some(ref p) if !p.is_empty() => {
            Some(state.encrypt(p.as_bytes())?)
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
    state.save(&data)?;

    Ok(key.redacted())
}

#[tauri::command]
pub async fn save_key_from_content(
    state: State<'_, AppState>,
    name: String,
    content: String,
    passphrase: Option<String>,
) -> CmdResult<KeyEntry> {
    let mut data = state.data.lock().await;

    let algorithm = detect_algorithm(&content);
    let encrypted_key = state.encrypt(content.as_bytes())?;

    let encrypted_passphrase = match passphrase {
        Some(ref p) if !p.is_empty() => {
            Some(state.encrypt(p.as_bytes())?)
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
    state.save(&data)?;

    Ok(key.redacted())
}

#[tauri::command]
pub async fn delete_key(state: State<'_, AppState>, key_id: String) -> CmdResult<()> {
    let mut data = state.data.lock().await;
    data.keys.retain(|k| k.id != key_id);
    super::records::forget_references_to(&mut data, &key_id);
    state.save(&data)
}

pub(super) fn detect_algorithm(pem: &str) -> Option<String> {
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
pub async fn convert_ppk(content: String, passphrase: Option<String>) -> CmdResult<String> {
    if !ppk::is_ppk(&content) {
        return Err("Not a PPK file".into());
    }
    ppk::ppk_to_openssh(&content, passphrase.as_deref()).map_err(CmdError::from)
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
) -> CmdResult<KeyContent> {
    let data = state.data.lock().await;
    let key = find_by_id(&data.keys, &key_id)
        .ok_or("Key not found")?;

    let private_pem = if let Some(ref enc) = key.encrypted_key {
        state.decrypt_str(enc)?
    } else if let Some(ref path) = key.key_path {
        std::fs::read_to_string(path)?
    } else {
        return Err("Key has no content or path".to_string().into());
    };

    let passphrase = key.encrypted_passphrase.as_ref()
        .and_then(|enc| state.decrypt_str(enc).ok());
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
) -> CmdResult<()> {
    let mut data = state.data.lock().await;
    let key = data.keys.iter_mut().find(|k| k.id == key_id)
        .ok_or("Key not found")?;
    key.name = name;
    key.algorithm = detect_algorithm(&content);
    key.encrypted_key = Some(state.encrypt(content.as_bytes())?);
    key.key_path = None;
    key.encrypted_passphrase = match passphrase {
        Some(ref p) if !p.is_empty() =>
            Some(state.encrypt(p.as_bytes())?),
        _ => key.encrypted_passphrase.clone(),
    };
    state.save(&data)
}

// ── Key generation ───────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct GeneratedKey {
    pub private_pem: String,
    pub public_openssh: String,
}

#[tauri::command]
pub async fn generate_key(algorithm: String, passphrase: Option<String>) -> CmdResult<GeneratedKey> {
    use ssh_key::{Algorithm, EcdsaCurve, LineEnding, PrivateKey};
    use ssh_key::private::{KeypairData, RsaKeypair};
    use rand::rngs::OsRng;

    let mut rng = OsRng;

    let key = match algorithm.as_str() {
        "ed25519" => PrivateKey::random(&mut rng, Algorithm::Ed25519)
            ?,
        "ecdsa-p256" => PrivateKey::random(&mut rng, Algorithm::Ecdsa { curve: EcdsaCurve::NistP256 })
            ?,
        "rsa-2048" => {
            let rsa = RsaKeypair::random(&mut rng, 2048)?;
            PrivateKey::new(KeypairData::Rsa(rsa), "")?
        }
        "rsa-4096" => {
            let rsa = RsaKeypair::random(&mut rng, 4096)?;
            PrivateKey::new(KeypairData::Rsa(rsa), "")?
        }
        _ => return Err(format!("Unknown algorithm: {}", algorithm).into()),
    };

    let public_openssh = key.public_key()
        .to_openssh()
        ?;

    let private_pem = match passphrase.as_deref().filter(|p| !p.is_empty()) {
        Some(p) => key.encrypt(&mut rng, p)
            ?
            .to_openssh(LineEnding::LF)
            ?
            .to_string(),
        None => key.to_openssh(LineEnding::LF)
            ?
            .to_string(),
    };

    Ok(GeneratedKey { private_pem, public_openssh })
}
