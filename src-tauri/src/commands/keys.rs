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
    let secret_key = state.key()?;
    let mut updated = false;
    for key in data.keys.iter_mut() {
        if key.algorithm.is_none() {
            // An entry that cannot be read is left without an algorithm rather
            // than failing the listing: the panel still has to show it, and
            // showing it is how the user finds out it is broken.
            if let Ok(pem) = super::records::key_pem(key, &secret_key) {
                key.algorithm = detect_algorithm(&pem);
                if key.algorithm.is_some() { updated = true; }
            }
        }
    }
    // Listing must not fail because a backfilled algorithm could not be
    // written, but a save that fails silently means the same detection runs on
    // every listing forever with nothing saying why.
    if updated {
        if let Err(e) = state.save(&data) {
            eprintln!("Could not record detected key algorithms: {e:?}");
        }
    }
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

    let content = if store_content { Some(std::fs::read_to_string(&path)?) } else { std::fs::read_to_string(&path).ok() };
    if content.as_deref().is_some_and(crate::sshcert::is_security_key) {
        return Err(crate::sshcert::SECURITY_KEY_REFUSED.into());
    }
    let algorithm = content.as_deref().and_then(detect_algorithm);
    let encrypted_key = match (&content, store_content) {
        (Some(content), true) => Some(state.encrypt(content.as_bytes())?),
        _ => None,
    };
    // The certificate beside the file, where ssh-keygen -s put it, if it is
    // this key's.
    let certificate = crate::sshcert::beside(&path).filter(|c| {
        content.as_deref().is_some_and(|k| crate::sshcert::check_for_key(c, k, passphrase.as_deref()).is_ok())
    });

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
        certificate,
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
    certificate: Option<String>,
) -> CmdResult<KeyEntry> {
    if crate::sshcert::is_security_key(&content) {
        return Err(crate::sshcert::SECURITY_KEY_REFUSED.into());
    }
    let certificate = certificate.map(|c| c.trim().to_string()).filter(|c| !c.is_empty());
    if let Some(cert) = &certificate {
        crate::sshcert::check_for_key(cert, &content, passphrase.as_deref())
            .map_err(|e| format!("Certificate: {e:#}"))?;
    }
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
        certificate,
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

/// Attaches a certificate to a key, or takes it off with None. Checked
/// first: it must be a user certificate for this very key.
#[tauri::command]
pub async fn set_key_certificate(
    state: State<'_, AppState>,
    key_id: String,
    certificate: Option<String>,
) -> CmdResult<KeyEntry> {
    let mut data = state.data.lock().await;
    let key = data.keys.iter().find(|k| k.id == key_id).ok_or("Key not found")?;
    let certificate = match certificate.map(|c| c.trim().to_string()).filter(|c| !c.is_empty()) {
        Some(text) => {
            let pem = super::records::key_pem(key, &state.key()?)?;
            let passphrase = match &key.encrypted_passphrase {
                Some(enc) => Some(state.decrypt_str(enc)?),
                None => None,
            };
            crate::sshcert::check_for_key(&text, &pem, passphrase.as_deref())?;
            Some(text)
        }
        None => None,
    };
    let key = data.keys.iter_mut().find(|k| k.id == key_id).ok_or("Key not found")?;
    key.certificate = certificate;
    let key = key.clone();
    state.save(&data)?;
    Ok(key.redacted())
}

/// Checks certificate text against a private key before anything is saved,
/// for the key forms to say at once whether it fits.
#[tauri::command]
pub async fn check_certificate(
    certificate: String,
    key_pem: String,
    passphrase: Option<String>,
) -> CmdResult<crate::sshcert::CertInfo> {
    crate::sshcert::check_for_key(&certificate, &key_pem, passphrase.as_deref().filter(|p| !p.is_empty()))
        .map_err(|e| format!("{e:#}").into())
}

/// What a key's certificate says, or None when it has none. A key kept by
/// path shows the certificate beside its file, the one a connect would use.
#[tauri::command]
pub async fn inspect_key_certificate(
    state: State<'_, AppState>,
    key_id: String,
) -> CmdResult<Option<crate::sshcert::CertInfo>> {
    let data = state.data.lock().await;
    let key = data.keys.iter().find(|k| k.id == key_id).ok_or("Key not found")?;
    let text = key.certificate.clone().or_else(|| key.key_path.as_deref().and_then(crate::sshcert::beside));
    Ok(match text {
        Some(t) => Some(crate::sshcert::inspect(&crate::sshcert::parse(&t)?)),
        None => None,
    })
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

    let private_pem = super::records::key_pem(key, &state.key()?)?;

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
    if crate::sshcert::is_security_key(&content) {
        return Err(crate::sshcert::SECURITY_KEY_REFUSED.into());
    }
    let mut data = state.data.lock().await;
    let key = data.keys.iter_mut().find(|k| k.id == key_id)
        .ok_or("Key not found")?;
    key.name = name;
    key.algorithm = detect_algorithm(&content);
    key.encrypted_key = Some(state.encrypt(content.as_bytes())?);
    // A key kept by path is stored from here on, so the certificate beside
    // its file would no longer be found; it is kept on the entry instead.
    if key.certificate.is_none() {
        key.certificate = key.key_path.as_deref().and_then(crate::sshcert::beside);
    }
    key.key_path = None;
    key.encrypted_passphrase = match passphrase {
        Some(ref p) if !p.is_empty() =>
            Some(state.encrypt(p.as_bytes())?),
        _ => key.encrypted_passphrase.clone(),
    };
    // A different key pasted in makes the certificate someone else's.
    let passphrase = match &key.encrypted_passphrase {
        Some(enc) => Some(state.decrypt_str(enc)?),
        None => None,
    };
    if key.certificate.as_deref().is_some_and(|c| crate::sshcert::check_for_key(c, &content, passphrase.as_deref()).is_err()) {
        key.certificate = None;
    }
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
        .to_openssh()?;

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
