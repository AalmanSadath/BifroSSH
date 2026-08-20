use super::CmdResult;

use crate::crypto::decrypt;
use crate::jump::JumpHop;
use crate::models::*;
use crate::ssh::SshAuth;


/// Everything needed to open a connection to a saved server.
pub(super) struct ServerTarget {
    pub host: String,
    pub port: u16,
    pub auth: SshAuth,
    pub jumps: Vec<JumpHop>,
}

/// Looks up a saved server and resolves the credential and chain named with it.
///
/// SFTP, tunnels and OS detection each wrote this out, and had already drifted:
/// one used an open-coded `iter().find()` where the others used `find_by_id`,
/// two wrote `server.port as u16` on a field that is already `u16`, and all
/// three called `state.key()` twice for the two resolutions that want the same
/// key. Sessions keep their own version, in `commands::ssh`, because a saved
/// host may carry a connection timeout and a quick connect has no host to
/// carry one.
///
/// Synchronous and taking `&AppData`, so the caller holds the lock once and
/// reads whatever else it needs from the same one.
pub(super) fn server_target(
    data: &AppData,
    secret_key: &[u8; 32],
    server_id: &str,
    auth_type: &str,
    auth_value: &str,
    jumps: Option<&[JumpHopRequest]>,
) -> CmdResult<ServerTarget> {
    let server = super::records::find_by_id(&data.servers, server_id).ok_or("Server not found")?;
    Ok(ServerTarget {
        host: server.host.clone(),
        port: server.port,
        auth: resolve_auth(data, secret_key, auth_type, auth_value)?,
        jumps: resolve_jumps(data, secret_key, jumps.unwrap_or(&[]))?,
    })
}

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

            let key_pem = super::records::key_pem(key, secret_key)?;

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
