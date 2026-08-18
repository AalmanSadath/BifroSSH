//! The Tauri command surface, one module per area of the app.
//!
//! Split out of a single 1683 line file along the section banners it already
//! carried. Nothing here is layered: the modules do not call one another, and
//! what two of them both need lives in this file or in `resolve`.
//!
//! Everything is re-exported flat, because `generate_handler!` in `lib.rs`
//! names commands as `commands::<name>` and that list should not have to
//! change when a command moves between modules.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, State};

use crate::hostkeys::ConnectSecurity;
use crate::models::*;
use crate::prompts::PromptState;
use crate::sftp::SftpClientState;
use crate::ssh::SshState;
use crate::tunnel::TunnelState;

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

// Command modules. `resolve` is not one of them: it holds the shared
// server-to-connection lookup that os, ssh, sftp and tunnel all need.
mod servers;
mod keys;
mod identities;
mod settings;
mod sshconfig;
mod transfer;
mod collections;
mod hostkeys;
mod os;
mod ssh;
mod sftp;
mod tunnel;
mod vault;
mod resolve;

pub use servers::*;
pub use keys::*;
pub use identities::*;
pub use settings::*;
pub use sshconfig::*;
pub use transfer::*;
pub use collections::*;
pub use hostkeys::*;
pub use os::*;
pub use ssh::*;
pub use sftp::*;
pub use tunnel::*;
pub use vault::*;
