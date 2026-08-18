use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tokio::sync::{oneshot, Mutex};

/// How long a prompt waits before giving up.
///
/// Long, because what it is waiting on is a person comparing a fingerprint or
/// reaching for a phone. The connect timeout is paused meanwhile, so this is
/// the only clock running.
const TIMEOUT_SECS: u64 = 300;

/// One prompt round-trip: mint an id, park a `oneshot` under it, emit the
/// event, wait, then clean up whether or not an answer arrived.
///
/// Both prompt paths ran their own copy of this. They differ only in which map
/// they register with, which event they emit, and what they make of no answer,
/// so the first two are arguments and the third is left to the caller: `None`
/// here means cancelled, timed out, or the sender was dropped, without saying
/// which.
///
/// The event is built from the id rather than passed in, because every payload
/// carries the id the answer will come back with.
///
/// `-cancel` is emitted unconditionally, not just on timeout. A modal the user
/// already dismissed ignores it; one still on screen because we gave up first
/// needs it, and telling those two cases apart here would only be a way to get
/// it wrong.
pub async fn request<T, E: Serialize + Clone>(
    map: &Mutex<HashMap<String, oneshot::Sender<T>>>,
    app: &AppHandle,
    waiting: &AtomicBool,
    channel: &str,
    event: impl FnOnce(String) -> E,
) -> Option<T> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let (tx, rx) = oneshot::channel();
    map.lock().await.insert(request_id.clone(), tx);

    waiting.store(true, Ordering::Relaxed);
    let _ = app.emit(channel, event(request_id.clone()));

    let answer = tokio::time::timeout(Duration::from_secs(TIMEOUT_SECS), rx)
        .await
        .ok()
        .and_then(Result::ok);

    waiting.store(false, Ordering::Relaxed);
    map.lock().await.remove(&request_id);
    let _ = app.emit(&format!("{channel}-cancel"), PromptCancelEvent { request_id });

    answer
}

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
