//! Deciding about a host key while a connection is being made.
//!
//! The other half of host keys. `hostkeys` is the known_hosts files: reading
//! them, matching a host against them, writing to them. This is what happens
//! when russh offers a key mid-handshake and something has to say yes or no,
//! which may mean stopping to ask the user.
//!
//! Split apart because they are different in kind. One is synchronous file
//! handling with no idea a connection exists, and carries almost all the
//! tests; the other is an async trait implementation holding a session's
//! worth of state. They were 1300 lines in one file.

use std::sync::{Arc, Mutex as StdMutex};

use async_trait::async_trait;
use russh::client;
use russh_keys::key::PublicKey;

use crate::connect::ConnectSecurity;
use crate::models::HostKeyPolicy;
use crate::hostkeys::{
    check_host, fingerprint, key_type, learn_host, replace_host, KnownHostStatus,
};
use crate::prompts::{self, HostKeyDecision, HostKeyPromptEvent};

#[derive(Clone)]
pub struct HostKeyVerifier {
    pub sec: ConnectSecurity,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    /// russh throws away the reason a handler rejected a key (see
    /// `client/mod.rs`: `Session::run` matches `Err(e)` and returns `Ok(())`
    /// with the propagation commented out). The caller would only ever see
    /// "Disconnected", so the real reason is recorded here instead.
    outcome: Arc<StdMutex<Option<String>>>,
    /// Whether this host is a jump host rather than the requested server.
    is_jump: bool,
}

impl HostKeyVerifier {
    pub fn new(sec: ConnectSecurity, host: &str, port: u16, username: Option<String>) -> Self {
        HostKeyVerifier {
            sec,
            host: host.to_string(),
            port,
            username,
            outcome: Arc::new(StdMutex::new(None)),
            is_jump: false,
        }
    }

    /// Marks this as a hop on the way somewhere else, so the prompt can say
    /// which machine it is asking the user to trust.
    pub fn into_jump(mut self) -> Self {
        self.is_jump = true;
        self
    }

    /// The rejection reason, if this verifier turned a key down.
    pub fn failure(&self) -> Option<String> {
        self.outcome.lock().ok().and_then(|g| g.clone())
    }

    fn fail(&self, message: String) {
        self.log("error", &message);
        if let Ok(mut guard) = self.outcome.lock() {
            *guard = Some(message);
        }
    }

    fn log(&self, kind: &str, message: &str) {
        self.sec.log(kind, message);
    }

    fn target(&self) -> String {
        match &self.username {
            Some(u) => format!("{}@{}:{}", u, self.host, self.port),
            None => format!("{}:{}", self.host, self.port),
        }
    }

    pub async fn verify(&self, key: &PublicKey) -> bool {
        let offered_type = key_type(key);
        let offered_fp = fingerprint(key);
        self.log(
            "auth",
            &format!("Checking host key ({} {})", offered_type, offered_fp),
        );

        match check_host(&self.host, self.port, key) {
            KnownHostStatus::Match { source } => {
                self.log(
                    "auth",
                    &format!("Host key verified against {} known_hosts", source.as_str()),
                );
                true
            }

            KnownHostStatus::Revoked => {
                self.fail(format!(
                    "The host key for {} is marked @revoked in known_hosts. Refusing to connect.",
                    self.target()
                ));
                false
            }

            status @ (KnownHostStatus::Mismatch(_) | KnownHostStatus::OtherType(_)) => {
                let (other_type, stored) = match status {
                    KnownHostStatus::OtherType(stored) => (true, stored),
                    KnownHostStatus::Mismatch(stored) => (false, stored),
                    _ => unreachable!("matched above"),
                };
                let target = self.target();
                let (stored_type, stored_fp) = (&stored.key_type, &stored.fingerprint);
                let summary = if other_type {
                    format!(
                        "{target} is known by its {stored_type} key ({stored_fp}), but offered a \
                         {offered_type} key ({offered_fp}) instead.\n\
                         Someone could be intercepting this connection, or the server no longer \
                         offers its {stored_type} key."
                    )
                } else {
                    format!(
                        "REMOTE HOST IDENTIFICATION HAS CHANGED for {target}.\n\
                         The stored key ({stored_type} {stored_fp}) does not match the key the \
                         server offered ({offered_type} {offered_fp}).\n\
                         Someone could be eavesdropping right now (man-in-the-middle attack), or the \
                         server's host key was changed."
                    )
                };
                self.fail(format!(
                    "{summary}\nStored in the {} known_hosts file, line {}.",
                    stored.source.as_str(),
                    stored.line,
                ));

                // Never learned silently, whatever the policy: accept-new is
                // for hosts that are new, and this one is not.
                if self.sec.policy != HostKeyPolicy::Ask || !self.sec.interactive {
                    return false;
                }

                let decision = self
                    .ask(KeyOffer {
                        status: if other_type { "other-type" } else { "mismatch" },
                        key_type: offered_type.clone(),
                        fingerprint: offered_fp.clone(),
                        existing_key_type: Some(stored.key_type),
                        existing_fingerprint: Some(stored.fingerprint),
                        source: Some(stored.source.as_str().to_string()),
                        line: Some(stored.line),
                    })
                    .await;

                if decision != HostKeyDecision::Replace {
                    return false;
                }
                // Replaces a stored key of the offered type, of which a host
                // known by another type has none: its other key is kept, as
                // OpenSSH keeps every type it has learned for a host.
                if let Err(e) = replace_host(&self.host, self.port, key) {
                    self.fail(format!("Could not update known_hosts: {}", e));
                    return false;
                }
                // The rejection reason recorded above no longer applies.
                if let Ok(mut guard) = self.outcome.lock() {
                    *guard = None;
                }
                self.log("auth", if other_type { "New host key type trusted by user" } else { "Stored host key replaced by user" });
                true
            }

            KnownHostStatus::Unknown => match self.sec.policy {
                HostKeyPolicy::AcceptNew => {
                    if let Err(e) = learn_host(&self.host, self.port, key) {
                        self.fail(format!("Could not write known_hosts: {}", e));
                        return false;
                    }
                    self.log("auth", "New host key accepted and saved (accept-new policy)");
                    true
                }

                HostKeyPolicy::Strict => {
                    self.fail(format!(
                        "The host key for {} is not in known_hosts, and the host key policy is \
                         set to strict. Refusing to connect.",
                        self.target()
                    ));
                    false
                }

                HostKeyPolicy::Ask => {
                    if !self.sec.interactive {
                        self.fail(format!(
                            "The host key for {} is not in known_hosts. Connect a terminal \
                             session first to review and trust it.",
                            self.target()
                        ));
                        return false;
                    }

                    match self
                        .ask(KeyOffer {
                            status: "unknown",
                            key_type: offered_type.clone(),
                            fingerprint: offered_fp.clone(),
                            existing_key_type: None,
                            existing_fingerprint: None,
                            source: None,
                            line: None,
                        })
                        .await
                    {
                        HostKeyDecision::Trust => {
                            if let Err(e) = learn_host(&self.host, self.port, key) {
                                self.fail(format!("Could not write known_hosts: {}", e));
                                return false;
                            }
                            self.log("auth", "Host key trusted and saved");
                            true
                        }
                        HostKeyDecision::Once => {
                            self.log("auth", "Host key accepted for this session only");
                            true
                        }
                        _ => {
                            self.fail(format!(
                                "Host key for {} was rejected.",
                                self.target()
                            ));
                            false
                        }
                    }
                }
            },
        }
    }

    /// Puts a key to the user and waits. No answer means reject: a prompt
    /// nobody was there to answer must not become a trusted host.
    async fn ask(&self, offer: KeyOffer) -> HostKeyDecision {
        prompts::request(
            &self.sec.prompts.host_keys,
            &self.sec.app,
            &self.sec.waiting,
            "host-key-prompt",
            |request_id| HostKeyPromptEvent {
                request_id,
                connect_id: self.sec.connect_id.clone(),
                host: self.host.clone(),
                port: self.port,
                username: self.username.clone(),
                status: offer.status.to_string(),
                key_type: offer.key_type,
                fingerprint: offer.fingerprint,
                existing_key_type: offer.existing_key_type,
                existing_fingerprint: offer.existing_fingerprint,
                source: offer.source,
                line: offer.line,
                is_jump: self.is_jump,
            },
        )
        .await
        .unwrap_or(HostKeyDecision::Reject)
    }
}

/// The half of a host key prompt that varies between the two call sites. These
/// are exactly the `HostKeyPromptEvent` fields the verifier cannot supply from
/// itself; the rest — host, port, username, connect id — it already knows.
struct KeyOffer {
    /// "unknown" | "mismatch" | "other-type" | "revoked"
    status: &'static str,
    key_type: String,
    fingerprint: String,
    existing_key_type: Option<String>,
    existing_fingerprint: Option<String>,
    source: Option<String>,
    line: Option<usize>,
}

/// The single `client::Handler` used by every connect path in the app.
///
/// Host key verification for every connection, and agent forwarding for the
/// one kind that asked for it: a terminal session on a host with the box
/// ticked. Everything else, jump hops, SFTP and tunnels included, is built
/// with forwarding disallowed and closes any agent channel the far side
/// opens.
pub struct VerifyingHandler {
    pub v: HostKeyVerifier,
    pub agent: crate::agent_forward::AgentForwarding,
}

impl VerifyingHandler {
    pub fn new(v: HostKeyVerifier) -> Self {
        VerifyingHandler { v, agent: crate::agent_forward::AgentForwarding::disallowed() }
    }
}

#[async_trait]
impl client::Handler for VerifyingHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        Ok(self.v.verify(key).await)
    }

    async fn server_channel_open_agent_forward(
        &mut self,
        channel: russh::ChannelId,
        session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        self.agent.open(channel, session).await;
        Ok(())
    }

    // Every channel's bytes come through here as well as through the
    // channel's own receiver; only an agent channel's are acted on.
    async fn data(
        &mut self,
        channel: russh::ChannelId,
        data: &[u8],
        session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        self.agent.data(channel, data, session).await;
        Ok(())
    }

    async fn channel_eof(
        &mut self,
        channel: russh::ChannelId,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        self.agent.closed(channel);
        Ok(())
    }

    async fn channel_close(
        &mut self,
        channel: russh::ChannelId,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        self.agent.closed(channel);
        Ok(())
    }
}

