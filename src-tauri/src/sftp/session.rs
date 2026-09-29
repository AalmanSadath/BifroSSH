//! Opening an SFTP session over SSH, and finding one again afterwards.

use super::*;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use russh_sftp::client::SftpSession;
use tokio::sync::Mutex;
use tokio::time::Duration;

use crate::connect::ConnectSecurity;
use crate::jump::JumpHop;
use crate::ssh::SshAuth;

// Threaded straight through from the command layer. Collapsing these into a
// params struct belongs with the wider connect-path dedup, not here.
#[allow(clippy::too_many_arguments)]
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
    proxy: Option<crate::proxycmd::ProxyCommand>,
) -> Result<()> {
    // The countdown pauses while a host key or auth prompt is on screen.
    let waiting = Arc::clone(&sec.waiting);
    crate::commands::timeout_pausable(
        connect_sftp_inner(sftp_state, session_id, host, port, username, auth, inactivity_timeout_secs, sec, jumps, proxy),
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
    proxy: Option<crate::proxycmd::ProxyCommand>,
) -> Result<()> {
    sec.log("auth", &format!("Starting SFTP connection to \"{}\" port \"{}\"", host, port));
    let handle = crate::ssh::connect_authenticated(
        host,
        port,
        username,
        &auth,
        &sec,
        &jumps,
        proxy.as_ref(),
        Some(Duration::from_secs(inactivity_timeout_secs as u64)),
    )
    .await?;

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

    // The handle is kept, not dropped: `download_archive` opens a second
    // channel on this same connection to run tar.
    sftp_state.sessions.lock().await.insert(
        session_id.to_string(),
        SftpConnection { sftp: Arc::new(Mutex::new(sftp)), opener: Arc::new(handle) },
    );

    Ok(())
}

pub async fn disconnect_sftp(sftp_state: &SftpClientState, session_id: &str) {
    let removed = sftp_state.sessions.lock().await.remove(session_id);
    sftp_state.names.lock().await.remove(session_id);
    if let Some(conn) = removed {
        if let Ok(sftp) = conn.sftp.try_lock() {
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
        .map(|c| Arc::clone(&c.sftp))
        .context("SFTP session not found")
}

/// Whether the session still answers.
///
/// The SSH handle is dropped once the channel is up, so the channel is the
/// only thing left to ask. `realpath` of `.` is what the OpenSSH client sends
/// first on every connection, and it is the cheapest request that needs the
/// server to do anything at all. Sent only after a listing has already
/// failed, to tell a bad path from a dead link.
/// The SSH connection under a session, for a second channel.
pub(super) async fn get_opener(
    sftp_state: &SftpClientState,
    session_id: &str,
) -> Result<Arc<dyn super::ChannelOpener>> {
    sftp_state.sessions.lock().await
        .get(session_id)
        .map(|c| Arc::clone(&c.opener))
        .context("SFTP session not found")
}

pub async fn probe_remote(sftp_state: &SftpClientState, session_id: &str) -> bool {
    let Ok(sftp_arc) = get_session(sftp_state, session_id).await else { return false };
    let sftp = sftp_arc.lock().await;
    sftp.canonicalize(".").await.is_ok()
}
