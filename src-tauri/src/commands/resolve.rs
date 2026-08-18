use super::CmdResult;

use crate::crypto::decrypt;
use crate::jump::JumpHop;
use crate::models::*;
use crate::ssh::SshAuth;


// ── Resolving a saved server into connectable parts ──────────────────

/// Turns the credential the frontend picked into something connectable.
///
/// The frontend decides *which* credential applies (identity or per-host,
/// agent or key or password); this decides what that credential means, which
/// for a key means going to the keychain for the material. Shared by sessions,
/// SFTP, tunnels and jump hosts so all four agree.
pub(super) fn resolve_auth(
    data: &AppData,
    secret_key: &[u8; 32],
    auth_type: &str,
    auth_value: &str,
) -> CmdResult<SshAuth> {
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
                let bytes = decrypt(enc, secret_key)?;
                String::from_utf8(bytes)?
            } else if let Some(path) = &key.key_path {
                std::fs::read_to_string(path)?
            } else {
                return Err("Key has no content or path".to_string().into());
            };

            let passphrase = match &key.encrypted_passphrase {
                Some(enc) => {
                    let bytes = decrypt(enc, secret_key)?;
                    Some(String::from_utf8(bytes)?)
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

pub(super) fn resolve_jumps(
    data: &AppData,
    secret_key: &[u8; 32],
    hops: &[JumpHopRequest],
) -> CmdResult<Vec<JumpHop>> {
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
