use std::collections::HashMap;
use std::sync::Arc;
use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use russh::*;
use russh_keys::key::KeyPair;
use tokio::sync::{mpsc, Mutex};
use tokio::time::{interval, Duration};
use tauri::{AppHandle, Emitter};

use crate::hostkeys::{ConnectSecurity, HostKeyVerifier, VerifyingHandler};

pub enum SshCommand {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

pub struct SshSessionHandle {
    pub cmd_tx: mpsc::Sender<SshCommand>,
}

pub struct SshState {
    pub sessions: Mutex<HashMap<String, SshSessionHandle>>,
}

impl SshState {
    pub fn new() -> Self {
        SshState {
            sessions: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(serde::Serialize, Clone)]
pub struct ConnectLogEvent {
    pub message: String,
    pub kind: String,
}

pub(crate) fn emit_log(app: &AppHandle, connect_id: &str, kind: &str, message: &str) {
    let _ = app.emit(&format!("ssh-connect-log:{}", connect_id), ConnectLogEvent {
        message: message.to_string(),
        kind: kind.to_string(),
    });
}

pub enum SshAuth {
    Password(String),
    KeyData { key_pem: String, passphrase: Option<String> },
}

/// What `authenticate` needs beyond the credential itself: who we are, and
/// where to narrate progress. Wraps `ConnectSecurity` rather than repeating
/// its fields, so the app handle, prompt broker and pause flag stay shared
/// with host key verification.
pub struct AuthContext {
    pub sec: ConnectSecurity,
    pub username: String,
}

impl AuthContext {
    pub fn new(sec: ConnectSecurity, username: &str) -> Self {
        AuthContext { sec, username: username.to_string() }
    }

    fn log(&self, kind: &str, message: &str) {
        if let Some(connect_id) = &self.sec.connect_id {
            emit_log(&self.sec.app, connect_id, kind, message);
        }
    }
}

/// The single authentication path for every connect in the app: terminal
/// sessions, SFTP, tunnels and one-shot commands.
pub async fn authenticate<H: client::Handler>(
    handle: &mut client::Handle<H>,
    auth: &SshAuth,
    ctx: &AuthContext,
) -> Result<()> {
    let authenticated = match auth {
        SshAuth::Password(password) => {
            handle.authenticate_password(&ctx.username, password).await?
        }
        SshAuth::KeyData { key_pem, passphrase } => {
            let key_pair: KeyPair = russh_keys::decode_secret_key(key_pem, passphrase.as_deref())?;
            ctx.log("network", "Authenticating using publickey method");
            handle
                .authenticate_publickey(&ctx.username, Arc::new(key_pair))
                .await?
        }
    };

    if !authenticated {
        return Err(anyhow!("Authentication failed"));
    }
    Ok(())
}

pub struct SshConnectParams {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
    pub initial_cols: u32,
    pub initial_rows: u32,
}

/// russh discards why a handler rejected a key: `Session::run` matches the
/// error arm, calls `disconnected(..)` and returns `Ok(())` with the
/// propagation commented out, so the caller only ever sees "Disconnected".
/// Prefer the reason the verifier recorded out-of-band.
pub(crate) fn host_key_error(verifier: &HostKeyVerifier, fallback: impl Into<anyhow::Error>) -> anyhow::Error {
    match verifier.failure() {
        Some(message) => anyhow!(message),
        None => fallback.into(),
    }
}

pub async fn exec_ssh_command(
    host: &str,
    port: u16,
    username: &str,
    auth: SshAuth,
    command: &str,
    sec: ConnectSecurity,
) -> Result<String> {
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(15)),
        ..Default::default()
    });

    let mut addrs = tokio::net::lookup_host(format!("{}:{}", host, port)).await?;
    let addr = addrs.next().ok_or_else(|| anyhow!("Cannot resolve host: {}", host))?;

    let verifier = HostKeyVerifier::new(sec.clone(), host, port, Some(username.to_string()));
    let mut handle = match client::connect(config, addr, VerifyingHandler { v: verifier.clone() }).await {
        Ok(h) => h,
        Err(e) => return Err(host_key_error(&verifier, e)),
    };

    authenticate(&mut handle, &auth, &AuthContext::new(sec, username)).await?;

    let mut channel = handle.channel_open_session().await?;
    channel.exec(true, command).await?;

    let output = tokio::time::timeout(Duration::from_secs(10), async move {
        let mut buf = Vec::new();
        loop {
            let Some(msg) = channel.wait().await else { break };
            match msg {
                ChannelMsg::Data { ref data } => buf.extend_from_slice(data.as_ref()),
                ChannelMsg::ExitStatus { .. } => {}
                _ => {}
            }
        }
        buf
    })
    .await
    .unwrap_or_default();

    let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;
    Ok(String::from_utf8_lossy(&output).to_string())
}

pub async fn connect_ssh(
    session_id: String,
    params: SshConnectParams,
    connect_id: String,
    app: AppHandle,
    ssh_state: Arc<SshState>,
    sec: ConnectSecurity,
) -> Result<()> {
    let config = Arc::new(client::Config {
        window_size: 4 * 1024 * 1024,
        maximum_packet_size: 64 * 1024,
        ..Default::default()
    });

    emit_log(&app, &connect_id, "auth", &format!("Starting a new connection to: \"{}\" port \"{}\"", params.host, params.port));
    emit_log(&app, &connect_id, "network", &format!("Starting address resolution of \"{}\"", params.host));
    let mut addrs = tokio::net::lookup_host(format!("{}:{}", params.host, params.port)).await?;
    let addr = addrs.next().ok_or_else(|| anyhow!("Cannot resolve host: {}", params.host))?;
    emit_log(&app, &connect_id, "network", "Address resolution finished");

    emit_log(&app, &connect_id, "network", &format!("Connecting to \"{}\" port \"{}\"", params.host, params.port));
    let verifier = HostKeyVerifier::new(sec.clone(), &params.host, params.port, Some(params.username.clone()));
    let mut handle = match client::connect(config, addr, VerifyingHandler { v: verifier.clone() }).await {
        Ok(h) => h,
        Err(e) => return Err(host_key_error(&verifier, e)),
    };
    emit_log(&app, &connect_id, "network", "TCP connection established");

    emit_log(&app, &connect_id, "auth", &format!("Authenticating to \"{}\":\"{}\" as \"{}\"", params.host, params.port, params.username));
    authenticate(&mut handle, &params.auth, &AuthContext::new(sec, &params.username)).await?;
    emit_log(&app, &connect_id, "auth", "Authentication succeeded");

    emit_log(&app, &connect_id, "network", "Opening session channel...");
    let mut channel = handle.channel_open_session().await?;

    emit_log(&app, &connect_id, "network", "Requesting PTY...");
    channel
        .request_pty(
            false,
            "xterm-256color",
            params.initial_cols,
            params.initial_rows,
            0,
            0,
            &[],
        )
        .await
        .map_err(|_| anyhow!("PTY request failed"))?;

    emit_log(&app, &connect_id, "network", "Starting shell...");
    channel
        .request_shell(false)
        .await
        .map_err(|_| anyhow!("Shell request failed"))?;

    emit_log(&app, &connect_id, "auth", "Shell ready — connected");

    let (cmd_tx, mut cmd_rx) = mpsc::channel::<SshCommand>(256);

    {
        let mut sessions = ssh_state.sessions.lock().await;
        sessions.insert(session_id.clone(), SshSessionHandle { cmd_tx });
    }

    let ssh_state_cleanup = Arc::clone(&ssh_state);
    let sid = session_id;

    tokio::spawn(async move {
        let mut flush_tick = interval(Duration::from_millis(8));
        flush_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut outbuf: Vec<u8> = Vec::with_capacity(8192);

        macro_rules! flush_outbuf {
            () => {
                if !outbuf.is_empty() {
                    let encoded = BASE64.encode(&outbuf);
                    let _ = app.emit(&format!("ssh-output:{}", sid), encoded);
                    outbuf.clear();
                }
            };
        }

        loop {
            tokio::select! {
                Some(cmd) = cmd_rx.recv() => {
                    match cmd {
                        SshCommand::Data(data) => {
                            if channel.data(data.as_slice()).await.is_err() {
                                break;
                            }
                        }
                        SshCommand::Resize { cols, rows } => {
                            let _ = channel.window_change(cols, rows, 0, 0).await;
                        }
                        SshCommand::Close => break,
                    }
                }
                Some(msg) = channel.wait() => {
                    match msg {
                        ChannelMsg::Data { ref data } => {
                            let was_empty = outbuf.is_empty();
                            outbuf.extend_from_slice(data.as_ref());
                            if was_empty || outbuf.len() >= 8192 {
                                flush_outbuf!();
                            }
                        }
                        ChannelMsg::ExtendedData { ref data, .. } => {
                            let was_empty = outbuf.is_empty();
                            outbuf.extend_from_slice(data.as_ref());
                            if was_empty || outbuf.len() >= 8192 {
                                flush_outbuf!();
                            }
                        }
                        ChannelMsg::Eof | ChannelMsg::Close => {
                            flush_outbuf!();
                            break;
                        }
                        ChannelMsg::ExitStatus { .. } => {}
                        _ => {}
                    }
                }
                _ = flush_tick.tick() => {
                    flush_outbuf!();
                }
                else => break,
            }
        }

        {
            let mut sessions = ssh_state_cleanup.sessions.lock().await;
            sessions.remove(&sid);
        }
        let _ = app.emit(&format!("ssh-closed:{}", sid), ());
    });

    Ok(())
}
