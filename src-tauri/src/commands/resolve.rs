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
    /// The ProxyCommand to dial with; see `first_proxy`.
    pub proxy: Option<crate::proxycmd::ProxyCommand>,
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
    username: &str,
    auth_type: AuthMethod,
    auth_value: &str,
    jumps: Option<&[JumpHopRequest]>,
) -> CmdResult<ServerTarget> {
    let server = super::records::find_by_id(&data.servers, server_id).ok_or("Server not found")?;
    let jumps = jumps.unwrap_or(&[]);
    Ok(ServerTarget {
        host: server.host.clone(),
        port: server.port,
        auth: resolve_auth(data, secret_key, auth_type, auth_value)?,
        jumps: resolve_jumps(data, secret_key, jumps)?,
        proxy: first_proxy(data, Some((server, username)), jumps)?,
    })
}

/// The ProxyCommand of whichever host is dialled first, with what its
/// tokens stand for: the outermost jump host's when there are jump hosts, else the
/// target's. As with OpenSSH, a host reached through another never uses its
/// own.
///
/// Read from the saved servers, never taken from the request: it is run on
/// this computer, so the frontend names a server and nothing more.
pub(super) fn first_proxy(
    data: &AppData,
    target: Option<(&Server, &str)>,
    jumps: &[JumpHopRequest],
) -> CmdResult<Option<crate::proxycmd::ProxyCommand>> {
    let first = match jumps.first() {
        Some(hop) => hop
            .server_id
            .as_deref()
            .and_then(|id| super::records::find_by_id(&data.servers, id))
            .map(|server| (server, hop.username.as_str())),
        None => target,
    };
    let Some((server, user)) = first else { return Ok(None) };
    let Some(command) = server.proxy_command.as_deref().filter(|c| !c.trim().is_empty()) else {
        return Ok(None);
    };
    Ok(Some(crate::proxycmd::ProxyCommand {
        command: command.trim().to_string(),
        host: server.host.clone(),
        port: server.port,
        user: user.to_string(),
    }))
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
    auth_type: AuthMethod,
    auth_value: &str,
) -> CmdResult<SshAuth> {
    match auth_type {
        // Nothing is stored: the server asks and the user answers at connect time.
        AuthMethod::KeyboardInteractive => Ok(SshAuth::KeyboardInteractive),
        AuthMethod::Agent => Ok(SshAuth::Agent {
            fingerprint: (!auth_value.is_empty()).then(|| auth_value.to_string()),
        }),
        AuthMethod::Password => Ok(SshAuth::Password(auth_value.to_string())),
        AuthMethod::Key => {
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

            // A certificate saved on the key, else one beside its file, as
            // OpenSSH looks for it.
            let cert = key
                .certificate
                .clone()
                .or_else(|| key.key_path.as_deref().and_then(crate::sshcert::beside));

            Ok(SshAuth::KeyData { key_pem, passphrase, cert })
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
    pub auth_type: AuthMethod,
    pub auth_value: String,
    /// The saved server this hop is, for its ProxyCommand.
    #[serde(default)]
    pub server_id: Option<String>,
}

pub(super) fn resolve_jumps(
    data: &AppData,
    secret_key: &[u8; 32],
    hops: &[JumpHopRequest],
) -> CmdResult<Vec<JumpHop>> {
    hops.iter()
        .map(|hop| {
            let auth = resolve_auth(data, secret_key, hop.auth_type, &hop.auth_value)
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

#[cfg(test)]
mod tests {
    use super::*;

    fn server(id: &str, host: &str, proxy: Option<&str>) -> Server {
        Server {
            id: id.to_string(),
            name: id.to_string(),
            host: host.to_string(),
            port: 2022,
            identity_id: None,
            username: None,
            encrypted_password: None,
            key_id: None,
            theme: None,
            os: String::new(),
            connection_timeout: None,
            auth_kind: None,
            proxy_jump: None,
            proxy_command: proxy.map(str::to_string),
            forward_agent: false, log_sessions: false, group: None, run_on_connect: None, hide_run_on_connect: true, notes: None, term: None, env: None, monitor: None, tags: Vec::new(),
        }
    }

    fn hop(server_id: &str, username: &str) -> JumpHopRequest {
        JumpHopRequest {
            host: String::new(),
            port: 22,
            username: username.to_string(),
            auth_type: AuthMethod::Password,
            auth_value: String::new(),
            server_id: Some(server_id.to_string()),
        }
    }

    fn expanded(proxy: Option<crate::proxycmd::ProxyCommand>) -> Option<String> {
        proxy.map(|p| p.expanded().unwrap())
    }

    #[test]
    fn a_direct_host_uses_its_own_proxy_command() {
        let data = AppData { servers: vec![server("t", "target", Some("nc %h %p # %r"))], ..Default::default() };
        let got = expanded(first_proxy(&data, Some((&data.servers[0], "alice")), &[]).unwrap());
        assert_eq!(got.as_deref(), Some("nc target 2022 # alice"));
    }

    /// Only the host dialled first runs a proxy command, as with OpenSSH: the
    /// outermost jump host's, filled in with its own name and user, and never
    /// the target's behind it.
    #[test]
    fn behind_a_jump_host_the_jump_hosts_command_is_used() {
        let data = AppData {
            servers: vec![server("t", "target", Some("never")), server("j", "bastion", Some("cloudflared %h as %r"))],
            ..Default::default()
        };
        let got = expanded(first_proxy(&data, Some((&data.servers[0], "alice")), &[hop("j", "ops")]).unwrap());
        assert_eq!(got.as_deref(), Some("cloudflared bastion as ops"));

        let plain = AppData { servers: vec![server("t", "target", Some("never")), server("j", "bastion", None)], ..Default::default() };
        assert_eq!(first_proxy(&plain, Some((&plain.servers[0], "alice")), &[hop("j", "ops")]).unwrap(), None);
    }

    #[test]
    fn a_blank_command_is_none() {
        let data = AppData { servers: vec![server("t", "target", Some("  "))], ..Default::default() };
        assert_eq!(first_proxy(&data, Some((&data.servers[0], "a")), &[]).unwrap(), None);
    }
}
