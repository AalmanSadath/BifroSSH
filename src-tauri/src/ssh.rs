use std::collections::HashMap;
use std::sync::Arc;
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use russh::*;
use russh_keys::key::KeyPair;
use tokio::sync::{mpsc, Mutex};
use tokio::time::{interval, Duration};
use tauri::{AppHandle, Emitter};

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

fn emit_log(app: &AppHandle, connect_id: &str, kind: &str, message: &str) {
    let _ = app.emit(&format!("ssh-connect-log:{}", connect_id), ConnectLogEvent {
        message: message.to_string(),
        kind: kind.to_string(),
    });
}

struct BasicClientHandler;

#[async_trait]
impl client::Handler for BasicClientHandler {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        _server_public_key: &russh_keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

struct LoggingClientHandler {
    app: AppHandle,
    connect_id: String,
}

#[async_trait]
impl client::Handler for LoggingClientHandler {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        _server_public_key: &russh_keys::key::PublicKey,
    ) -> Result<bool, Self::Error> {
        emit_log(&self.app, &self.connect_id, "auth", "Checking host key...");
        emit_log(&self.app, &self.connect_id, "auth", "Host key accepted");
        Ok(true)
    }
}

pub enum SshAuth {
    Password(String),
    KeyData { key_pem: String, passphrase: Option<String> },
}

pub struct SshConnectParams {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
    pub initial_cols: u32,
    pub initial_rows: u32,
}

pub async fn exec_ssh_command(
    host: &str,
    port: u16,
    username: &str,
    auth: SshAuth,
    command: &str,
) -> Result<String> {
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(15)),
        ..Default::default()
    });

    let mut addrs = tokio::net::lookup_host(format!("{}:{}", host, port)).await?;
    let addr = addrs.next().ok_or_else(|| anyhow!("Cannot resolve host: {}", host))?;

    let mut handle = client::connect(config, addr, BasicClientHandler).await?;

    let authenticated = match &auth {
        SshAuth::Password(password) => handle.authenticate_password(username, password).await?,
        SshAuth::KeyData { key_pem, passphrase } => {
            let key_pair: KeyPair = russh_keys::decode_secret_key(key_pem, passphrase.as_deref())?;
            handle.authenticate_publickey(username, Arc::new(key_pair)).await?
        }
    };

    if !authenticated {
        return Err(anyhow!("Authentication failed"));
    }

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
    let handler = LoggingClientHandler { app: app.clone(), connect_id: connect_id.clone() };
    let mut handle = client::connect(config, addr, handler).await?;
    emit_log(&app, &connect_id, "network", "TCP connection established");

    emit_log(&app, &connect_id, "auth", &format!("Authenticating to \"{}\":\"{}\" as \"{}\"", params.host, params.port, params.username));
    let authenticated = match &params.auth {
        SshAuth::Password(password) => {
            handle.authenticate_password(&params.username, password).await?
        }
        SshAuth::KeyData { key_pem, passphrase } => {
            let pass = passphrase.as_deref();
            let key_pair: KeyPair = russh_keys::decode_secret_key(key_pem, pass)?;
            emit_log(&app, &connect_id, "network", "Authenticating using publickey method");
            handle.authenticate_publickey(&params.username, Arc::new(key_pair)).await?
        }
    };

    if !authenticated {
        return Err(anyhow!("Authentication failed"));
    }
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
