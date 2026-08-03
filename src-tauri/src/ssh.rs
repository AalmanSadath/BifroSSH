use std::collections::HashMap;
use std::sync::Arc;
use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use russh::*;
use russh_keys::key::KeyPair;
use tokio::sync::{mpsc, Mutex};
use tokio::time::{interval, Duration};
use std::sync::atomic::Ordering;
use russh::client::{KeyboardInteractiveAuthResponse, Prompt};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;
use tokio::time::timeout;

use crate::hostkeys::{ConnectSecurity, HostKeyVerifier, VerifyingHandler};
use crate::prompts::{AuthPromptEvent, AuthPromptField, PromptCancelEvent};

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
    /// PAM-style challenge/response, and the transport for most 2FA setups.
    KeyboardInteractive,
    /// Keys held by a running ssh-agent. The private key never enters this
    /// process. `fingerprint` pins one specific key; None tries each in turn.
    Agent { fingerprint: Option<String> },
}

/// What `authenticate` needs beyond the credential itself: who we are, and
/// where to narrate progress. Wraps `ConnectSecurity` rather than repeating
/// its fields, so the app handle, prompt broker and pause flag stay shared
/// with host key verification.
pub struct AuthContext {
    pub sec: ConnectSecurity,
    pub username: String,
    /// Shown in the prompt so the user knows which server is asking.
    pub host: String,
}

/// How the keyboard-interactive loop reaches a human. Split out from
/// `AuthContext` so the loop can be exercised in tests without a Tauri
/// AppHandle -- the zero-prompt and multi-round cases are impossible to
/// reproduce by hand without a live PAM or Duo server.
#[async_trait::async_trait]
pub(crate) trait AuthPrompter: Sync {
    fn interactive(&self) -> bool;
    fn log(&self, kind: &str, message: &str);
    async fn ask(&self, name: &str, instructions: &str, prompts: &[Prompt]) -> Option<Vec<String>>;
}

#[async_trait::async_trait]
impl AuthPrompter for AuthContext {
    fn interactive(&self) -> bool {
        self.sec.interactive
    }

    fn log(&self, kind: &str, message: &str) {
        AuthContext::log(self, kind, message);
    }

    async fn ask(&self, name: &str, instructions: &str, prompts: &[Prompt]) -> Option<Vec<String>> {
        AuthContext::ask(self, name, instructions, prompts).await
    }
}

impl AuthContext {
    pub fn new(sec: ConnectSecurity, username: &str) -> Self {
        AuthContext { sec, username: username.to_string(), host: String::new() }
    }

    pub fn with_host(mut self, host: &str) -> Self {
        self.host = host.to_string();
        self
    }

    fn log(&self, kind: &str, message: &str) {
        self.sec.log(kind, message);
    }

    /// Puts one round of prompts to the user. `None` means they cancelled, or
    /// nobody answered in time.
    async fn ask(
        &self,
        name: &str,
        instructions: &str,
        prompts: &[Prompt],
    ) -> Option<Vec<String>> {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.sec.prompts.auth.lock().await.insert(request_id.clone(), tx);

        let event = AuthPromptEvent {
            request_id: request_id.clone(),
            connect_id: self.sec.connect_id.clone(),
            host: self.host.clone(),
            username: self.username.clone(),
            name: name.to_string(),
            instructions: instructions.to_string(),
            prompts: prompts
                .iter()
                .map(|p| AuthPromptField { prompt: p.prompt.clone(), echo: p.echo })
                .collect(),
        };

        self.sec.waiting.store(true, Ordering::Relaxed);
        let _ = self.sec.app.emit("auth-prompt", event);

        let answers = match timeout(Duration::from_secs(300), rx).await {
            Ok(Ok(answers)) => answers,
            _ => None,
        };

        self.sec.waiting.store(false, Ordering::Relaxed);
        self.sec.prompts.auth.lock().await.remove(&request_id);
        let _ = self
            .sec
            .app
            .emit("auth-prompt-cancel", PromptCancelEvent { request_id });

        answers
    }
}

/// Authenticates with keys held by a running ssh-agent.
///
/// The agent does the signing, so the private key never enters this process.
/// That is the only way to use hardware-backed keys, which cannot be exported.
#[cfg(unix)]
pub(crate) async fn agent_auth<H: client::Handler>(
    handle: &mut client::Handle<H>,
    username: &str,
    want_fingerprint: Option<&str>,
    ctx: &dyn AuthPrompter,
) -> Result<bool> {
    use russh_keys::agent::client::AgentClient;

    let mut agent = AgentClient::connect_env().await.map_err(|e| {
        anyhow!("Could not reach ssh-agent ({}). Check that an agent is running and SSH_AUTH_SOCK is set.", e)
    })?;

    // Identities this build cannot parse are skipped rather than aborting the
    // listing; see the russh-keys patch under patches/.
    let identities = agent
        .request_identities()
        .await
        .map_err(|e| anyhow!("Could not list ssh-agent keys: {}", e))?;

    if identities.is_empty() {
        return Err(anyhow!(
            "ssh-agent is running but holds no usable keys. Add one with `ssh-add`."
        ));
    }
    ctx.log("auth", &format!("ssh-agent offered {} key(s)", identities.len()));

    let mut tried = 0usize;
    for key in identities {
        let fingerprint = crate::hostkeys::fingerprint(&key);
        if let Some(want) = want_fingerprint {
            if fingerprint != want {
                continue;
            }
        }
        tried += 1;
        ctx.log("auth", &format!("Trying agent key {} {}", key.name(), fingerprint));

        // Returns a tuple rather than a Result, and hands the signer back --
        // it must be reassigned or the next key cannot be attempted.
        let (returned, result) = handle.authenticate_future(username, key, agent).await;
        agent = returned;

        match result {
            Ok(true) => return Ok(true),
            Ok(false) => {}
            Err(e) => ctx.log("auth", &format!("Agent key rejected: {}", e)),
        }
    }

    if tried == 0 {
        return Err(anyhow!(
            "The selected key is no longer in ssh-agent. Add it back with `ssh-add`, or choose a different key."
        ));
    }
    Ok(false)
}

/// Server-driven challenge/response. Each round may carry any number of
/// prompts, including none.
pub(crate) async fn keyboard_interactive<H: client::Handler>(
    handle: &mut client::Handle<H>,
    username: &str,
    ctx: &dyn AuthPrompter,
) -> Result<bool> {
    let mut response = handle
        .authenticate_keyboard_interactive_start(username, None)
        .await?;

    // A well-behaved server converges in a handful of rounds; the cap stops a
    // broken or hostile one from looping forever.
    for _ in 0..20 {
        match response {
            KeyboardInteractiveAuthResponse::Success => return Ok(true),
            KeyboardInteractiveAuthResponse::Failure => return Ok(false),
            KeyboardInteractiveAuthResponse::InfoRequest { name, instructions, prompts } => {
                if !instructions.trim().is_empty() {
                    ctx.log("auth", instructions.trim());
                }

                let answers = if prompts.is_empty() {
                    // Not a question. Servers use an empty request to display
                    // status -- "Pushed a login request to your phone" -- and
                    // expect an immediate empty reply. Showing a modal here
                    // would hang the login waiting for input nobody can give.
                    Vec::new()
                } else if !ctx.interactive() {
                    return Ok(false);
                } else {
                    match ctx.ask(&name, &instructions, &prompts).await {
                        Some(answers) => answers,
                        None => {
                            ctx.log("auth", "Authentication cancelled");
                            return Ok(false);
                        }
                    }
                };

                response = handle
                    .authenticate_keyboard_interactive_respond(answers)
                    .await?;
            }
        }
    }

    Err(anyhow!("Server sent too many authentication prompts"))
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
        SshAuth::KeyboardInteractive => {
            ctx.log("network", "Authenticating using keyboard-interactive method");
            return match keyboard_interactive(handle, &ctx.username, ctx).await? {
                true => Ok(()),
                false => Err(anyhow!("Authentication failed")),
            };
        }
        #[cfg(unix)]
        SshAuth::Agent { fingerprint } => {
            ctx.log("network", "Authenticating using ssh-agent");
            agent_auth(handle, &ctx.username, fingerprint.as_deref(), ctx).await?
        }
        #[cfg(not(unix))]
        SshAuth::Agent { .. } => return Err(anyhow!("ssh-agent is only supported on Unix")),
    };

    if authenticated {
        return Ok(());
    }

    // russh 0.44's client API never surfaces the server's accepted-method list
    // (Reply::AuthFailure carries no payload), so there is no way to ask what
    // to try next -- fall back blind. This is the common case of a server with
    // PasswordAuthentication off that offers PAM keyboard-interactive instead,
    // and of any 2FA setup.
    //
    // The stored password is deliberately not replayed into these prompts: the
    // server picks the prompt text and could ask for anything at all.
    if ctx.sec.interactive {
        ctx.log("auth", "Retrying with keyboard-interactive");
        if keyboard_interactive(handle, &ctx.username, ctx).await? {
            return Ok(());
        }
    }

    Err(anyhow!("Authentication failed"))
}

pub struct SshConnectParams {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
    pub initial_cols: u32,
    pub initial_rows: u32,
    /// Seconds between keepalives; 0 disables them.
    pub keepalive_secs: u32,
}

/// russh sends a keepalive every interval and gives up after `keepalive_max`
/// unanswered ones (3 by default), so a dead peer surfaces after roughly
/// 3x the interval instead of the session hanging indefinitely.
pub(crate) fn keepalive_interval(secs: u32) -> Option<Duration> {
    (secs > 0).then(|| Duration::from_secs(secs as u64))
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

    authenticate(&mut handle, &auth, &AuthContext::new(sec, username).with_host(host)).await?;

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
        keepalive_interval: keepalive_interval(params.keepalive_secs),
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
    authenticate(&mut handle, &params.auth, &AuthContext::new(sec, &params.username).with_host(&params.host)).await?;
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
