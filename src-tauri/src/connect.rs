//! What a connection attempt carries with it, apart from the socket.
//!
//! Its narration, the host key policy it was started under, and the way back
//! to the user when something has to be asked. `hostkeys` and `ssh` both need
//! all of it, and it used to live in the two of them: `ConnectSecurity` and
//! the policy in `hostkeys`, the log in `ssh`, each reaching into the other.
//! Here it belongs to neither and both can depend on it.

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use tauri::{AppHandle, Emitter};

use crate::models::HostKeyPolicy;
use crate::prompts::PromptState;

/// One line of the narration a connect writes to its ConnectingView.
#[derive(serde::Serialize, Clone)]
pub struct ConnectLogEvent {
    pub message: String,
    pub kind: String,
}

/// Sends one line to the view watching this connect. Addressed per connect, so
/// two running at once do not write into each other's log.
pub(crate) fn emit_log(app: &AppHandle, connect_id: &str, kind: &str, message: &str) {
    let _ = app.emit(
        &format!("ssh-connect-log:{}", connect_id),
        ConnectLogEvent { message: message.to_string(), kind: kind.to_string() },
    );
}

/// Everything a connect needs in order to decide about a host key.
#[derive(Clone)]
pub struct ConnectSecurity {
    pub app: AppHandle,
    pub prompts: Arc<PromptState>,
    pub policy: HostKeyPolicy,
    /// `Some` also narrates into the ConnectingView log for that connect.
    pub connect_id: Option<String>,
    /// Background connects (OS detection) cannot prompt and must fail closed.
    pub interactive: bool,
    /// Raised while a modal is up. The command that owns the connect timeout
    /// watches this so a user reading a fingerprint isn't timed out.
    pub waiting: Arc<AtomicBool>,
}

impl ConnectSecurity {
    /// Narrates a step into the connection log. A connect with no `connect_id`
    /// (background OS detection) has nowhere to show it, so this is a no-op.
    pub fn log(&self, kind: &str, message: &str) {
        if let Some(connect_id) = &self.connect_id {
            emit_log(&self.app, connect_id, kind, message);
        }
    }

    pub fn new(
        app: AppHandle,
        prompts: Arc<PromptState>,
        policy: HostKeyPolicy,
        connect_id: Option<String>,
        interactive: bool,
    ) -> Self {
        ConnectSecurity {
            app,
            prompts,
            policy,
            connect_id,
            interactive,
            waiting: Arc::new(AtomicBool::new(false)),
        }
    }
}
