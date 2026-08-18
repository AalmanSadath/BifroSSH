use tauri::State;
use uuid::Uuid;

use crate::crypto::{decrypt, encrypt};
use crate::models::*;
use crate::ppk;
use crate::store::save_app_data;

use super::AppState;

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
    if updated { let _ = save_app_data(&data, &state.key()?); }
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
    save_app_data(&data, &state.key()?).map_err(|e| e.to_string())?;

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
    save_app_data(&data, &state.key()?).map_err(|e| e.to_string())?;

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
    save_app_data(&data, &state.key()?).map_err(|e| e.to_string())
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
    save_app_data(&data, &state.key()?).map_err(|e| e.to_string())
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
