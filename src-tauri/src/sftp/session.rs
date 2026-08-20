//! Opening an SFTP session over SSH, and finding one again afterwards.

use super::*;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use russh_sftp::client::SftpSession;
use tokio::sync::Mutex;
use tokio::time::Duration;
use russh::*;

use crate::connect::ConnectSecurity;
use crate::hostverify::{HostKeyVerifier, VerifyingHandler};
use crate::jump::JumpHop;
use crate::ssh::{AuthContext, SshAuth};

pub async fn connect_sftp(
    sftp_state: &SftpClientState,
    session_id: &str,
    host: &str,
    port: u16,
    username: &str,
    auth: SshAuth,
    inactivity_timeout_secs: u32,
    sec: ConnectSecurity,
    jumps: Vec<JumpHop>,
) -> Result<()> {
    // The countdown pauses while a host key or auth prompt is on screen.
    let waiting = Arc::clone(&sec.waiting);
    crate::commands::timeout_pausable(
        connect_sftp_inner(sftp_state, session_id, host, port, username, auth, inactivity_timeout_secs, sec, jumps),
        30,
        waiting,
    )
    .await
    .map_err(|_| anyhow!("Connection timed out after 30 seconds"))?
}

// Threaded straight through from the command layer. Collapsing these into a
// params struct belongs with the wider connect-path dedup, not here.
#[allow(clippy::too_many_arguments)]
async fn connect_sftp_inner(
    sftp_state: &SftpClientState,
    session_id: &str,
    host: &str,
    port: u16,
    username: &str,
    auth: SshAuth,
    inactivity_timeout_secs: u32,
    sec: ConnectSecurity,
    jumps: Vec<JumpHop>,
) -> Result<()> {
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(inactivity_timeout_secs as u64)),
        ..Default::default()
    });

    sec.log("auth", &format!("Starting SFTP connection to \"{}\" port \"{}\"", host, port));

    // Resolution, the TCP connect, and every jump host in between.
    let transport = crate::jump::open_transport(&jumps, host, port, &sec, None)
        .await
        .inspect_err(|e| sec.log("error", &format!("{e:#}")))?;

    let verifier = HostKeyVerifier::new(sec.clone(), host, port, Some(username.to_string()));
    let mut handle =
        crate::ssh::connect_verified(config, transport, verifier, |v| VerifyingHandler { v })
            .await
            .inspect_err(|e| sec.log("error", &format!("{e:#}")))?;

    sec.log("auth", &format!("Authenticating to \"{}\":\"{}\" as \"{}\"", host, port, username));
    crate::ssh::authenticate(&mut handle, &auth, &AuthContext::new(sec.clone(), username).with_host(host))
        .await
        .inspect_err(|e| sec.log("error", &format!("{e:#}")))?;
    sec.log("auth", "Authentication succeeded");

    sec.log("network", "Opening session channel...");
    let channel = handle.channel_open_session().await?;

    sec.log("network", "Requesting SFTP subsystem...");
    channel
        .request_subsystem(true, "sftp")
        .await
        .inspect_err(|e| sec.log("error", &format!("SFTP subsystem request failed: {e}")))?;

    let sftp = SftpSession::new(channel.into_stream())
        .await
        .inspect_err(|e| sec.log("error", &format!("SFTP session failed to start: {e}")))?;
    sec.log("auth", "SFTP ready");

    sftp_state.sessions.lock().await
        .insert(session_id.to_string(), Arc::new(Mutex::new(sftp)));

    // handle intentionally dropped; channel stream keeps connection alive
    drop(handle);

    Ok(())
}

pub async fn disconnect_sftp(sftp_state: &SftpClientState, session_id: &str) {
    let removed = sftp_state.sessions.lock().await.remove(session_id);
    if let Some(sftp_arc) = removed {
        if let Ok(sftp) = sftp_arc.try_lock() {
            let _ = sftp.close().await;
        }
    }
}

pub(super) async fn get_session(
    sftp_state: &SftpClientState,
    session_id: &str,
) -> Result<Arc<Mutex<SftpSession>>> {
    sftp_state.sessions.lock().await
        .get(session_id)
        .cloned()
        .context("SFTP session not found")
}
