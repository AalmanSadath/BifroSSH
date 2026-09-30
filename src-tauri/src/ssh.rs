use std::collections::HashMap;
use std::sync::Arc;
use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use russh::*;
use tokio::sync::{mpsc, Mutex};
use tokio::time::{interval, Duration};
use tauri::{AppHandle, Emitter};

mod auth;
mod echo;

#[cfg(test)]
mod auth_tests;

pub(crate) use auth::{
    agent_identities, agent_stream, authenticate, identity_key, AgentStream, AuthContext, SshAuth,
};
use echo::EchoFilter;

use crate::connect::{emit_log, ConnectSecurity};
use crate::hostverify::{HostKeyVerifier, VerifyingHandler};
use crate::jump::{self, JumpHop};

pub enum SshCommand {
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    /// Start writing output to this file, or stop. Opened by the caller,
    /// so the loop never learns a path.
    SetLog(Option<std::fs::File>),
    /// Start recording output with its timing, or stop.
    SetRecording(Option<crate::recording::Recorder>),
    /// The terminal has finished a ZMODEM transfer, or found that what
    /// looked like one was not: output goes to the log and recording again.
    TransferDone,
    Close,
}

/// Why a session ended, sent with `ssh-closed` so the tab can tell a shell
/// that exited from a link that died. The first closes the tab; the second
/// keeps it, scrollback and all, with a way to reconnect.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CloseReason {
    /// The shell ended and said so: `exit`, or the last process finishing.
    Exited,
    /// The user closed the tab.
    Closed,
    /// Anything else: the transport went away, or the channel closed
    /// without an exit status, which is what a server dying looks like.
    Dropped,
}


/// The reason, from what the pump loop saw.
///
/// An exit status arrives before the channel closes on a clean exit and
/// never arrives on a drop, so it is the one thing that tells the two apart.
/// A close the user asked for is known from the command that did it.
pub fn close_reason(closed_by_user: bool, saw_exit_status: bool) -> CloseReason {
    if closed_by_user {
        CloseReason::Closed
    } else if saw_exit_status {
        CloseReason::Exited
    } else {
        CloseReason::Dropped
    }
}

#[derive(Clone, Debug, serde::Serialize)]
pub struct ClosedEvent {
    pub reason: CloseReason,
    /// What the remote command or shell exited with, when it said. A
    /// container tab uses it to tell a command that failed from one that
    /// finished.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_status: Option<u32>,
}

/// Output produced before the terminal is listening.
///
/// The shell starts writing the moment its channel opens, but the session id
/// does not reach the frontend until the connect call returns, and only then
/// does a terminal mount and subscribe. Tauri events are not queued, so
/// anything emitted across that gap is simply gone: usually the motd and the
/// first prompt, on a fast host most of what the session has to say.
///
/// So the reader holds it here instead, and hands it over when the terminal
/// says it is ready. The `attached` flag and the buffer live behind one lock
/// on purpose. Checked separately, output emitted between the drain and the
/// flag being set belongs to neither path and is lost, which is the bug this
/// exists to fix.
#[derive(Default)]
pub struct Attach {
    pub attached: bool,
    pub pending: Vec<u8>,
}

/// Enough for any plausible login banner. A session whose tab never mounts
/// stops accumulating rather than growing for as long as the process runs;
/// the oldest bytes go first, since the recent ones are the useful ones.
const MAX_PENDING: usize = 256 * 1024;

impl Attach {
    /// Returns false once the frontend has taken over and output should be
    /// emitted live instead.
    pub fn hold(&mut self, data: &[u8]) -> bool {
        if self.attached {
            return false;
        }
        self.pending.extend_from_slice(data);
        if self.pending.len() > MAX_PENDING {
            let excess = self.pending.len() - MAX_PENDING;
            self.pending.drain(..excess);
        }
        true
    }

    pub fn take(&mut self) -> Vec<u8> {
        self.attached = true;
        std::mem::take(&mut self.pending)
    }
}

/// Where a session's output goes: batched, into the log and the recording
/// if there are any, then to the terminal, or held until it has attached.
///
/// Shared by the SSH session loop and the local shell's, so both treat
/// their output the same way.
pub(crate) struct SessionOutput {
    app: AppHandle,
    sid: String,
    attach: Arc<Mutex<Attach>>,
    pub log: Option<std::fs::File>,
    pub recorder: Option<crate::recording::Recorder>,
    /// Waiting for the next flush.
    pub buf: Vec<u8>,
    /// A ZMODEM transfer is under way: its bytes are file data, not
    /// something to keep in a log or play back, so neither gets them until
    /// the terminal says it is over.
    transfer: bool,
    /// The end of the last flush, for a header split across two.
    tail: Vec<u8>,
}

/// How every ZMODEM session starts on the wire: a hex header, `**`, ZDLE,
/// `B`, then the type's first digit. ZRQINIT (`sz`) and ZRINIT (`rz`) both
/// begin with `0`.
const ZMODEM_START: &[u8] = b"**\x18B0";

/// Where in `buf` a ZMODEM transfer starts, if one does: 0 when the header
/// began at the end of `tail`, the previous chunk.
pub(crate) fn zmodem_start(tail: &[u8], buf: &[u8]) -> Option<usize> {
    let mut joined = tail.to_vec();
    joined.extend_from_slice(buf);
    joined
        .windows(ZMODEM_START.len())
        .position(|w| w == ZMODEM_START)
        .map(|at| at.saturating_sub(tail.len()))
}

/// Where `needle` first appears in `haystack`.
fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|w| w == needle)
}

impl SessionOutput {
    pub fn new(app: AppHandle, sid: String, attach: Arc<Mutex<Attach>>, log: Option<std::fs::File>) -> Self {
        SessionOutput {
            app,
            sid,
            attach,
            log,
            recorder: None,
            buf: Vec::with_capacity(8192),
            transfer: false,
            tail: Vec::new(),
        }
    }

    pub fn transfer_done(&mut self) {
        self.transfer = false;
        self.tail.clear();
    }

    pub async fn flush(&mut self) {
        if self.buf.is_empty() {
            return;
        }
        // What the log and recording get: everything, up to where a
        // transfer starts, and nothing while one runs.
        let kept = if self.transfer {
            0
        } else {
            match zmodem_start(&self.tail, &self.buf) {
                Some(at) => {
                    self.transfer = true;
                    at
                }
                None => self.buf.len(),
            }
        };
        let tail_from = self.buf.len().saturating_sub(ZMODEM_START.len() - 1);
        self.tail = self.buf[tail_from..].to_vec();

        // Before the hold, so a tab that never attaches still logs. A file
        // that will not take the bytes is dropped rather than allowed to end
        // the session.
        if kept > 0 {
            use std::io::Write;
            if self.log.as_mut().is_some_and(|file| file.write_all(&self.buf[..kept]).is_err()) {
                drop(self.log.take());
            }
            if self.recorder.as_mut().is_some_and(|r| r.output(&self.buf[..kept]).is_err()) {
                drop(self.recorder.take());
            }
        }
        // Held rather than emitted until a terminal has attached, under the
        // same lock the handover takes.
        if !self.attach.lock().await.hold(&self.buf) {
            let encoded = BASE64.encode(&self.buf);
            let _ = self.app.emit(&format!("ssh-output:{}", self.sid), encoded);
        }
        self.buf.clear();
    }

    /// The terminal changed size: a recording keeps that.
    pub fn resized(&mut self, cols: u32, rows: u32) {
        if self.recorder.as_mut().is_some_and(|r| r.resize(cols, rows).is_err()) {
            drop(self.recorder.take());
        }
    }
}

pub struct SshSessionHandle {
    pub cmd_tx: mpsc::Sender<SshCommand>,
    pub attach: Arc<Mutex<Attach>>,
    /// The connection itself, for a command run beside the shell on its own
    /// channel, such as the monitor bar's sample: no second login, no second
    /// host-key check. Dropped with this entry when the session loop ends, so
    /// it does not keep a closed session's connection open.
    ///
    /// None for a local shell, which has no connection to open one on.
    pub opener: Option<Arc<dyn crate::sftp::ChannelOpener>>,
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


pub struct SshConnectParams {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
    pub initial_cols: u32,
    pub initial_rows: u32,
    /// Seconds between keepalives; 0 disables them.
    pub keepalive_secs: u32,
    /// Jump hosts to reach this server through, outermost first. Empty for a
    /// direct connection.
    pub jumps: Vec<JumpHop>,
    /// The ProxyCommand to dial with.
    pub proxy: Option<crate::proxycmd::ProxyCommand>,
    /// ssh's -A: the remote may use the local agent for as long as the
    /// session lasts. Per host and off by default; see agent_forward.
    pub forward_agent: bool,
    /// A log already open, so the banner and motd are in it too.
    pub log: Option<std::fs::File>,
    /// One line typed into the shell for the user as soon as it is up.
    pub run_on_connect: Option<String>,
    /// Whether that line's echo is taken back out of the terminal.
    pub hide_run_on_connect: bool,
    /// Run this instead of the login shell, as `ssh -t host command` does:
    /// a shell in a container, or its logs. The tab closes when it exits.
    pub command: Option<String>,
    /// The sudo password, sent when sudo prompts with its marker.
    pub sudo: Option<crate::containers::SudoAnswer>,
    /// The terminal type the PTY is asked for.
    pub term: String,
    /// Variables to ask the server to set before the shell starts.
    pub env: Vec<(String, String)>,
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

/// Runs the target's own handshake on top of an already-open transport.
///
/// Six call sites wrote out the same `match`, only to turn a russh error that
/// is really a rejected host key into the message the user needs to see. The
/// verifier holds that message, so it has to outlive the handler that reports
/// into it.
///
/// The handler is built here from the verifier rather than passed in ready
/// made, because two callers wrap it in something larger: a remote-forward
/// handler carries its destination, and a jump hop marks itself as one first.
pub(crate) async fn connect_verified<H>(
    mut config: client::Config,
    transport: jump::BoxedTransport,
    verifier: HostKeyVerifier,
    handler: impl FnOnce(HostKeyVerifier) -> H,
) -> Result<client::Handle<H>>
where
    H: client::Handler + Send + 'static,
    H::Error: Into<anyhow::Error>,
{
    // Key types already trusted for this host are asked for first, so a
    // server that has one of them is checked against what is stored.
    let known = crate::hostkeys::known_key_types(&verifier.host, verifier.port);
    config.preferred.key = crate::hostkeys::key_order(&known).into();
    let handler = handler(verifier.clone());
    client::connect_stream(Arc::new(config), transport, handler)
        .await
        .map_err(|e| host_key_error(&verifier, e))
}

/// A connection that is up, verified and authenticated, with nothing opened
/// on it yet: what a panel with its own connection (SFTP, Containers) starts
/// from. The connect is narrated into `sec`'s log, failures included.
// Threaded straight through from the command layer, like connect_sftp.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn connect_authenticated(
    host: &str,
    port: u16,
    username: &str,
    auth: &SshAuth,
    sec: &ConnectSecurity,
    jumps: &[JumpHop],
    proxy: Option<&crate::proxycmd::ProxyCommand>,
    inactivity_timeout: Option<Duration>,
) -> Result<client::Handle<VerifyingHandler>> {
    let config = client::Config { inactivity_timeout, ..Default::default() };

    // Resolution, the TCP connect, and every jump host in between.
    let transport = jump::open_transport(jumps, host, port, proxy, sec, None)
        .await
        .inspect_err(|e| sec.log("error", &format!("{e:#}")))?;

    let verifier = HostKeyVerifier::new(sec.clone(), host, port, Some(username.to_string()));
    let mut handle = connect_verified(config, transport, verifier, VerifyingHandler::new)
        .await
        .inspect_err(|e| sec.log("error", &format!("{e:#}")))?;

    sec.log("auth", &format!("Authenticating to \"{}\":\"{}\" as \"{}\"", host, port, username));
    authenticate(&mut handle, auth, &AuthContext::new(sec.clone(), username).with_host(host))
        .await
        .inspect_err(|e| sec.log("error", &format!("{e:#}")))?;
    sec.log("auth", "Authentication succeeded");
    Ok(handle)
}

// Threaded straight through from the command layer, like connect_sftp.
#[allow(clippy::too_many_arguments)]
pub async fn exec_ssh_command(
    host: &str,
    port: u16,
    username: &str,
    auth: SshAuth,
    command: &str,
    sec: ConnectSecurity,
    jumps: &[JumpHop],
    proxy: Option<&crate::proxycmd::ProxyCommand>,
) -> Result<String> {
    let config = client::Config {
        inactivity_timeout: Some(Duration::from_secs(15)),
        ..Default::default()
    };

    let transport = jump::open_transport(jumps, host, port, proxy, &sec, None).await?;

    let verifier = HostKeyVerifier::new(sec.clone(), host, port, Some(username.to_string()));
    let mut handle = connect_verified(config, transport, verifier, VerifyingHandler::new).await?;

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
    let config = client::Config {
        window_size: 4 * 1024 * 1024,
        maximum_packet_size: 64 * 1024,
        keepalive_interval: keepalive_interval(params.keepalive_secs),
        ..Default::default()
    };

    emit_log(&app, &connect_id, "auth", &format!("Starting a new connection to: \"{}\" port \"{}\"", params.host, params.port));

    // Resolution, the TCP connect, and every jump host in between. With no
    // jump hosts this is exactly the direct connection it always was.
    let transport = jump::open_transport(
        &params.jumps,
        &params.host,
        params.port,
        params.proxy.as_ref(),
        &sec,
        keepalive_interval(params.keepalive_secs),
    )
    .await?;

    let verifier = HostKeyVerifier::new(sec.clone(), &params.host, params.port, Some(params.username.clone()));
    // Forwarding is decided here, per host, and nowhere else: the handler is
    // built allowing it or not, and a server that opens an agent channel
    // against a handler that does not allow it gets that channel closed.
    let forward_agent = params.forward_agent;
    let agent_sec = sec.clone();
    let mut handle = connect_verified(config, transport, verifier, move |v| VerifyingHandler {
        v,
        agent: if forward_agent {
            crate::agent_forward::AgentForwarding::allowed(agent_sec)
        } else {
            crate::agent_forward::AgentForwarding::disallowed()
        },
    })
    .await?;

    emit_log(&app, &connect_id, "auth", &format!("Authenticating to \"{}\":\"{}\" as \"{}\"", params.host, params.port, params.username));
    authenticate(&mut handle, &params.auth, &AuthContext::new(sec, &params.username).with_host(&params.host)).await?;
    emit_log(&app, &connect_id, "auth", "Authentication succeeded");

    emit_log(&app, &connect_id, "network", "Opening session channel...");
    let mut channel = handle.channel_open_session().await?;

    emit_log(&app, &connect_id, "network", "Requesting PTY...");
    channel
        .request_pty(
            false,
            &params.term,
            params.initial_cols,
            params.initial_rows,
            0,
            0,
            &[],
        )
        .await
        .map_err(|_| anyhow!("PTY request failed"))?;

    if params.forward_agent {
        // Tried once now so the user learns at connect that there is no
        // agent to forward, rather than at the first ssh-add -l on the far
        // side. The request goes ahead either way; the answer to each
        // channel is decided when it is opened.
        match agent_stream().await {
            Ok(_) => emit_log(&app, &connect_id, "auth", "Forwarding the local ssh-agent to this host"),
            Err(e) => emit_log(&app, &connect_id, "error", &format!("Agent forwarding requested, but {e:#}")),
        }
        if let Err(e) = channel.agent_forward(true).await {
            emit_log(&app, &connect_id, "error", &format!("Agent forwarding request failed: {e}"));
        }
    }

    // Between the PTY and the shell, which is where ssh itself sends them.
    // No reply is asked for: a server sets AcceptEnv to say which names it
    // will take and drops the rest without a word, and a variable it will not
    // set is no reason to fail the connection.
    for (name, value) in &params.env {
        if let Err(e) = channel.set_env(false, name.as_str(), value.as_str()).await {
            emit_log(&app, &connect_id, "error", &format!("Could not ask for {name}: {e}"));
        }
    }
    if !params.env.is_empty() {
        let names: Vec<&str> = params.env.iter().map(|(n, _)| n.as_str()).collect();
        emit_log(&app, &connect_id, "network", &format!("Asked the server to set {}", names.join(", ")));
    }

    match &params.command {
        Some(command) => {
            emit_log(&app, &connect_id, "network", &format!("Running: {command}"));
            channel
                .exec(false, command.as_str())
                .await
                .map_err(|_| anyhow!("The server refused to run the command"))?;
        }
        None => {
            emit_log(&app, &connect_id, "network", "Starting shell...");
            channel
                .request_shell(false)
                .await
                .map_err(|_| anyhow!("Shell request failed"))?;
        }
    }

    emit_log(&app, &connect_id, "auth", "Shell ready, connected");

    // The startup command is not written here. Sent the moment the shell was
    // requested, it queued in the tty and was echoed once in the middle of
    // the login banner and again by readline when the prompt was finally
    // drawn, which reads as the app having typed it twice. It goes below
    // instead, once the shell has finished saying hello.
    let mut startup = params.run_on_connect.clone();
    let mut sudo = params.sudo.clone();
    let hide_startup = params.hide_run_on_connect;
    let startup_log = startup.is_some().then(|| (app.clone(), connect_id.clone()));

    let (cmd_tx, mut cmd_rx) = mpsc::channel::<SshCommand>(256);
    let attach = Arc::new(Mutex::new(Attach::default()));

    // Kept rather than dropped now that the shell is up, which is what used to
    // happen: `channel_open_session` takes `&self`, so one handle behind an
    // Arc can open channels for anyone holding it.
    let opener: Arc<dyn crate::sftp::ChannelOpener> = Arc::new(handle);
    {
        let mut sessions = ssh_state.sessions.lock().await;
        sessions.insert(
            session_id.clone(),
            SshSessionHandle { cmd_tx, attach: Arc::clone(&attach), opener: Some(opener) },
        );
    }

    let ssh_state_cleanup = Arc::clone(&ssh_state);
    let sid = session_id;

    tokio::spawn(async move {
        // When output last arrived, and when the shell came up: the startup
        // command waits for a gap in the greeting, and goes anyway if a
        // server says nothing at all.
        let mut quiet_since: Option<tokio::time::Instant> = None;
        let shell_at = tokio::time::Instant::now();
        // Set when the startup command goes out, to take its echo back out of
        // the output. Given up on after a moment, whether the echo was found
        // or not, so nothing is ever held back for long.
        let mut echo: Option<(EchoFilter, tokio::time::Instant)> = None;
        /// How long the echo of a startup command is waited for.
        const ECHO_WINDOW: Duration = Duration::from_secs(5);
        /// A pause this long in the output is the greeting being over.
        const SETTLE: Duration = Duration::from_millis(250);
        /// Past this, the command goes whether it looks settled or not.
        const STARTUP_BY: Duration = Duration::from_secs(3);

        let mut flush_tick = interval(Duration::from_millis(8));
        flush_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut out = SessionOutput::new(app.clone(), sid.clone(), Arc::clone(&attach), params.log);
        let mut exit_status: Option<u32> = None;
        let mut closed_by_user = false;
        // When EOF arrived, if it has. The loop stays for the close that
        // follows, but not forever: a server that sends EOF and then nothing
        // is a server that has gone.
        let mut eof_at: Option<tokio::time::Instant> = None;
        const AFTER_EOF: Duration = Duration::from_secs(3);

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
                            out.resized(cols, rows);
                        }
                        SshCommand::SetLog(file) => {
                            out.log = file;
                        }
                        SshCommand::SetRecording(next) => {
                            // What is waiting to go out belongs to the old
                            // recording, not the new one.
                            out.flush().await;
                            out.recorder = next;
                        }
                        SshCommand::TransferDone => out.transfer_done(),
                        SshCommand::Close => {
                            closed_by_user = true;
                            break;
                        }
                    }
                }
                Some(msg) = channel.wait() => {
                    match msg {
                        // stderr goes to the same terminal as stdout, which
                        // is what a PTY session means, so the two arms are one.
                        ChannelMsg::Data { ref data }
                        | ChannelMsg::ExtendedData { ref data, .. } => {
                            let was_empty = out.buf.is_empty();
                            quiet_since = Some(tokio::time::Instant::now());
                            match echo.as_mut() {
                                Some((filter, _)) => filter.feed(data.as_ref(), &mut out.buf),
                                None => out.buf.extend_from_slice(data.as_ref()),
                            }
                            // The sudo prompt of a container tab, with echo
                            // already off: answered, and taken out of what
                            // the terminal is shown.
                            let at = sudo.as_ref().and_then(|s| find(&out.buf, &s.marker).map(|at| (at, s.marker.len())));
                            if let Some((at, len)) = at {
                                out.buf.drain(at..at + len);
                                if let Some(answer) = sudo.take() {
                                    if channel.data(answer.input.as_slice()).await.is_err() {
                                        break;
                                    }
                                }
                            }
                            if was_empty || out.buf.len() >= 8192 {
                                out.flush().await;
                            }
                        }
                        // OpenSSH ends a session as EOF, then the exit
                        // status, then CLOSE, in that order. Breaking on EOF
                        // left before the status arrived, so a typed exit
                        // was reported as a dropped connection.
                        ChannelMsg::Eof => {
                            out.flush().await;
                            eof_at.get_or_insert_with(tokio::time::Instant::now);
                        }
                        ChannelMsg::Close => {
                            out.flush().await;
                            break;
                        }
                        // Sent by the server when the shell ends on its own.
                        // Remembered rather than acted on: the close that
                        // follows is what ends the loop.
                        ChannelMsg::ExitStatus { exit_status: code } => exit_status = Some(code),
                        _ => {}
                    }
                }
                _ = flush_tick.tick() => {
                    out.flush().await;
                    if startup.is_some()
                        && (quiet_since.is_some_and(|t| t.elapsed() >= SETTLE)
                            || shell_at.elapsed() >= STARTUP_BY)
                    {
                        let cmd = startup.take().unwrap_or_default();
                        if let Some((app, connect_id)) = &startup_log {
                            emit_log(app, connect_id, "auth", "Sending the startup command");
                        }
                        if hide_startup {
                            echo = Some((EchoFilter::new(&cmd), tokio::time::Instant::now() + ECHO_WINDOW));
                        }
                        if channel.data(format!("{cmd}\n").as_bytes()).await.is_err() {
                            break;
                        }
                    }
                    // The echo either arrived and was taken out, or it never
                    // came and whatever was held goes back where it was.
                    if let Some((filter, until)) = echo.as_mut() {
                        if filter.is_done() || tokio::time::Instant::now() >= *until {
                            filter.give_up(&mut out.buf);
                            echo = None;
                            out.flush().await;
                        }
                    }
                    if eof_at.is_some_and(|t| t.elapsed() > AFTER_EOF) {
                        break;
                    }
                }
                else => break,
            }
        }

        {
            let mut sessions = ssh_state_cleanup.sessions.lock().await;
            sessions.remove(&sid);
        }
        let reason = close_reason(closed_by_user, exit_status.is_some());
        let _ = app.emit(&format!("ssh-closed:{}", sid), ClosedEvent { reason, exit_status });
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `sz` and `rz` announce themselves with this; what came before it is
    /// terminal output and is kept.
    #[test]
    fn a_zmodem_start_is_found_where_it_begins() {
        assert_eq!(zmodem_start(b"", b"rz waiting to receive.**\x18B0100000023be50\r\n"), Some(22));
        assert_eq!(zmodem_start(b"", b"**\x18B00000000000000\r\n"), Some(0));
        assert_eq!(zmodem_start(b"", b"plain output ** with stars"), None);
    }

    /// Output arrives in whatever pieces the channel gives; a header split
    /// between two is still a header.
    #[test]
    fn a_zmodem_start_split_across_chunks_is_found() {
        assert_eq!(zmodem_start(b"xx**", b"\x18B00000"), Some(0));
        assert_eq!(zmodem_start(b"**\x18", b"B0"), Some(0));
        assert_eq!(zmodem_start(b"**\x18", b"C0"), None);
    }

    /// The tab closes on the first two and stays on the third.
    #[test]
    fn a_close_is_told_apart_from_an_exit_and_a_drop() {
        assert_eq!(close_reason(true, false), CloseReason::Closed);
        assert_eq!(close_reason(true, true), CloseReason::Closed, "the user's close wins");
        assert_eq!(close_reason(false, true), CloseReason::Exited);
        assert_eq!(close_reason(false, false), CloseReason::Dropped);
    }

    #[test]
    fn the_reason_is_sent_as_the_word_the_frontend_matches_on() {
        let json = serde_json::to_string(&ClosedEvent { reason: CloseReason::Dropped, exit_status: None }).unwrap();
        assert_eq!(json, r#"{"reason":"dropped"}"#);
    }

    #[test]
    fn output_is_held_until_the_terminal_attaches() {
        let mut a = Attach::default();

        assert!(a.hold(b"motd line\r\n"), "nothing is listening yet");
        assert!(a.hold(b"user@host:~$ "));

        assert_eq!(a.take(), b"motd line\r\nuser@host:~$ ");
        assert!(
            !a.hold(b"typed later"),
            "once attached, output belongs to the event stream"
        );
        assert!(a.take().is_empty(), "and is not also buffered");
    }

    #[test]
    fn a_session_nobody_opens_stops_growing() {
        let mut a = Attach::default();
        let chunk = vec![b'x'; 64 * 1024];
        for _ in 0..8 {
            a.hold(&chunk);
        }
        assert_eq!(a.pending.len(), MAX_PENDING);
    }

    #[test]
    fn the_most_recent_output_is_the_part_kept() {
        let mut a = Attach::default();
        a.hold(&vec![b'o'; MAX_PENDING]);
        a.hold(b"the newest bytes");

        let kept = a.take();
        assert_eq!(kept.len(), MAX_PENDING);
        assert!(
            kept.ends_with(b"the newest bytes"),
            "the oldest output is what gets dropped"
        );
    }
}
