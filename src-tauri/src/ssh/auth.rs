//! Proving who we are to a server.
//!
//! Four methods, tried in the order the request asked for: an agent, a key,
//! a password, and the keyboard-interactive rounds a server uses for
//! one-time codes and push approvals. What they have in common is that each
//! one can fail in a way the user has to read, so every step narrates itself
//! through the connect log.

use std::sync::Arc;

use anyhow::{anyhow, Result};
use russh::client::{self, KeyboardInteractiveAuthResponse, Prompt};
use russh_keys::key::KeyPair;

use crate::connect::ConnectSecurity;
use crate::prompts::{self, AuthPromptEvent, AuthPromptField};

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
    ///
    /// The channel carries `Option<Vec<String>>`, so a delivered "cancel" and a
    /// missing answer both arrive as `None` and flatten together — which is
    /// right, because the caller treats them the same.
    async fn ask(
        &self,
        name: &str,
        instructions: &str,
        prompts: &[Prompt],
    ) -> Option<Vec<String>> {
        prompts::request(
            &self.sec.prompts.auth,
            &self.sec.app,
            &self.sec.waiting,
            "auth-prompt",
            |request_id| AuthPromptEvent {
                request_id,
                connect_id: self.sec.connect_id.clone(),
                host: self.host.clone(),
                username: self.username.clone(),
                name: name.to_string(),
                instructions: instructions.to_string(),
                prompts: prompts
                    .iter()
                    .map(|p| AuthPromptField { prompt: p.prompt.clone(), echo: p.echo })
                    .collect(),
            },
        )
        .await
        .flatten()
    }
}

/// The stream an ssh-agent speaks over on this platform.
///
/// `AgentClient` is generic over any `AsyncRead + AsyncWrite`, so the protocol
/// half of the crate needs nothing platform-specific -- only the connect does.
/// That is why this is a type alias and one small function rather than a type
/// parameter threaded through `agent_identities` and `agent_auth`.
#[cfg(unix)]
pub(crate) type AgentStream = tokio::net::UnixStream;
#[cfg(windows)]
pub(crate) type AgentStream = tokio::net::windows::named_pipe::NamedPipeClient;

/// Where the agent listens.
///
/// Unix: the socket named by `SSH_AUTH_SOCK`, which is the only place to look.
///
/// Windows: a named pipe. The OpenSSH agent service always uses
/// `\\.\pipe\openssh-ssh-agent` and sets no environment variable, so that is
/// the default -- but `SSH_AUTH_SOCK` is honoured when set, because the agents
/// that replace the built-in one (1Password, a WSL bridge) advertise their own
/// pipe that way.
#[cfg(unix)]
pub(crate) async fn agent_stream() -> Result<AgentStream> {
    let sock = std::env::var("SSH_AUTH_SOCK").map_err(|_| {
        anyhow!("Could not reach ssh-agent: SSH_AUTH_SOCK is not set, so no agent is running for this session.")
    })?;
    tokio::net::UnixStream::connect(&sock).await.map_err(|e| {
        anyhow!("Could not reach ssh-agent at {} ({}). Check that an agent is running.", sock, e)
    })
}

#[cfg(windows)]
pub(crate) async fn agent_stream() -> Result<AgentStream> {
    const DEFAULT_PIPE: &str = r"\\.\pipe\openssh-ssh-agent";
    let pipe = std::env::var("SSH_AUTH_SOCK").unwrap_or_else(|_| DEFAULT_PIPE.to_string());
    tokio::net::windows::named_pipe::ClientOptions::new()
        .open(&pipe)
        .map_err(|e| {
            anyhow!(
                "Could not reach ssh-agent at {} ({}). Start it with `Start-Service ssh-agent`, \
                 or set it to start automatically in Services.",
                pipe,
                e
            )
        })
}

/// Connects to the running ssh-agent and asks what it holds.
///
/// Both callers want the same two steps and the same two messages, and a
/// user-facing string written out twice is one that gets improved in one place
/// only. The client comes back too, because authenticating means going to the
/// same agent again to have it sign.
///
/// Identities this build cannot parse are skipped rather than aborting the
/// listing; see the russh-keys patch under patches/.
#[cfg(any(unix, windows))]
pub(crate) async fn agent_identities(
) -> Result<(russh_keys::agent::client::AgentClient<AgentStream>, Vec<russh_keys::key::PublicKey>)> {
    use russh_keys::agent::client::AgentClient;

    let mut agent = AgentClient::connect(agent_stream().await?);

    let identities = agent
        .request_identities()
        .await
        .map_err(|e| anyhow!("Could not list ssh-agent keys: {}", e))?;

    Ok((agent, identities))
}

/// Authenticates with keys held by a running ssh-agent.
///
/// The agent does the signing, so the private key never enters this process.
/// That is the only way to use hardware-backed keys, which cannot be exported.
#[cfg(any(unix, windows))]
pub(crate) async fn agent_auth<H: client::Handler>(
    handle: &mut client::Handle<H>,
    username: &str,
    want_fingerprint: Option<&str>,
    ctx: &dyn AuthPrompter,
) -> Result<bool> {
    let (mut agent, identities) = agent_identities().await?;

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
        #[cfg(any(unix, windows))]
        SshAuth::Agent { fingerprint } => {
            ctx.log("network", "Authenticating using ssh-agent");
            agent_auth(handle, &ctx.username, fingerprint.as_deref(), ctx).await?
        }
        #[cfg(not(any(unix, windows)))]
        SshAuth::Agent { .. } => {
            return Err(anyhow!("ssh-agent is not supported on this platform"))
        }
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
