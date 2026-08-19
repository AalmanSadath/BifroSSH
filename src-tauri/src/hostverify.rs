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

use crate::connect::{ConnectSecurity, HostKeyPolicy};
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

            KnownHostStatus::Mismatch {
                source,
                line,
                existing_type,
                existing_fp,
            } => {
                self.fail(format!(
                    "REMOTE HOST IDENTIFICATION HAS CHANGED for {target}.\n\
                     The stored key ({existing_type} {existing_fp}) does not match the key the \
                     server offered ({offered_type} {offered_fp}).\n\
                     Someone could be eavesdropping right now (man-in-the-middle attack), or the \
                     server's host key was changed.\n\
                     Stored in the {source} known_hosts file, line {line}.",
                    target = self.target(),
                    source = source.as_str(),
                ));

                if self.sec.policy != HostKeyPolicy::Ask || !self.sec.interactive {
                    return false;
                }

                let decision = self
                    .ask(KeyOffer {
                        status: "mismatch",
                        key_type: offered_type.clone(),
                        fingerprint: offered_fp.clone(),
                        existing_key_type: Some(existing_type),
                        existing_fingerprint: Some(existing_fp),
                        source: Some(source.as_str().to_string()),
                        line: Some(line),
                    })
                    .await;

                if decision != HostKeyDecision::Replace {
                    return false;
                }
                if let Err(e) = replace_host(&self.host, self.port, key) {
                    self.fail(format!("Could not update known_hosts: {}", e));
                    return false;
                }
                // The rejection reason recorded above no longer applies.
                if let Ok(mut guard) = self.outcome.lock() {
                    *guard = None;
                }
                self.log("auth", "Stored host key replaced by user");
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
    /// "unknown" | "mismatch" | "revoked"
    status: &'static str,
    key_type: String,
    fingerprint: String,
    existing_key_type: Option<String>,
    existing_fingerprint: Option<String>,
    source: Option<String>,
    line: Option<usize>,
}

/// The single `client::Handler` used by every connect path in the app.
pub struct VerifyingHandler {
    pub v: HostKeyVerifier,
}

#[async_trait]
impl client::Handler for VerifyingHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        Ok(self.v.verify(key).await)
    }
}

