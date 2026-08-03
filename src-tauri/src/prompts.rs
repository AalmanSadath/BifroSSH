use std::collections::HashMap;

use tokio::sync::{oneshot, Mutex};

/// Brokers the round-trips where a connect has to stop and ask the user
/// something. The connect side parks on a `oneshot`; the Tauri command the UI
/// calls looks the sender up by `request_id` and completes it.
pub struct PromptState {
    pub host_keys: Mutex<HashMap<String, oneshot::Sender<HostKeyDecision>>>,
    pub auth: Mutex<HashMap<String, oneshot::Sender<Option<Vec<String>>>>>,
}

impl PromptState {
    pub fn new() -> Self {
        PromptState {
            host_keys: Mutex::new(HashMap::new()),
            auth: Mutex::new(HashMap::new()),
        }
    }
}

#[derive(serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum HostKeyDecision {
    /// Trust and write to known_hosts.
    Trust,
    /// Accept for this connection only, without persisting.
    Once,
    /// Overwrite the stored key for this host (mismatch case).
    Replace,
    Reject,
}

impl HostKeyDecision {
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "trust" => Some(HostKeyDecision::Trust),
            "once" => Some(HostKeyDecision::Once),
            "replace" => Some(HostKeyDecision::Replace),
            "reject" => Some(HostKeyDecision::Reject),
            _ => None,
        }
    }
}

/// Emitted globally (not per-`connect_id`) so one modal at the App level can
/// serve terminal connects, SFTP, tunnels and OS detection alike.
#[derive(serde::Serialize, Clone)]
pub struct HostKeyPromptEvent {
    pub request_id: String,
    pub connect_id: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    /// "unknown" | "mismatch" | "revoked"
    pub status: String,
    pub key_type: String,
    pub fingerprint: String,
    pub existing_key_type: Option<String>,
    pub existing_fingerprint: Option<String>,
    pub source: Option<String>,
    pub line: Option<usize>,
    /// This is a jump host on the way to somewhere else, not the server the
    /// user asked for. Worth saying, because a chain asks about each hop in
    /// turn and the prompts are otherwise indistinguishable.
    pub is_jump: bool,
}

#[derive(serde::Serialize, Clone)]
pub struct PromptCancelEvent {
    pub request_id: String,
}

#[derive(serde::Serialize, Clone)]
pub struct AuthPromptField {
    pub prompt: String,
    /// False for secrets — the server decides, and passwords must stay masked.
    pub echo: bool,
}

/// One round of a keyboard-interactive exchange. The server chooses the
/// wording, so `name`, `instructions` and each prompt are rendered as untrusted
/// text, never interpreted.
#[derive(serde::Serialize, Clone)]
pub struct AuthPromptEvent {
    pub request_id: String,
    pub connect_id: Option<String>,
    pub host: String,
    pub username: String,
    pub name: String,
    pub instructions: String,
    pub prompts: Vec<AuthPromptField>,
}
