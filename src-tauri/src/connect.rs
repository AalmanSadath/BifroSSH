//! What a connection attempt carries with it, apart from the socket.
//!
//! Its narration, the host key policy it was started under, and the way back
//! to the user when something has to be asked. `hostkeys` and `ssh` both need
//! all of it, and it used to live in the two of them: `ConnectSecurity` and
//! the policy in `hostkeys`, the log in `ssh`, each reaching into the other.
//! Here it belongs to neither and both can depend on it.

use std::collections::HashMap;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use tauri::{AppHandle, Emitter};

use crate::models::{HostKeyChanges, HostKeyPolicy};
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
    /// Each saved address's [`HostKeyChanges`], read when the connect
    /// starts. Keyed by address rather than by host record because a jump
    /// hop, a tunnel and a quick connection all reach a device by its
    /// address, and the setting is about the device.
    pub key_changes: Arc<HashMap<(String, u16), HostKeyChanges>>,
}

impl ConnectSecurity {
    /// What this address allows when it offers a key other than the stored
    /// one. An address no saved host names is `Block`.
    pub fn key_changes_for(&self, host: &str, port: u16) -> HostKeyChanges {
        self.key_changes
            .get(&(host.to_ascii_lowercase(), port))
            .copied()
            .unwrap_or_default()
    }

    /// Builds the address map from the saved hosts. Two records naming the
    /// same address are the same device, so the more permissive setting of
    /// the two is the one the user set for it.
    pub fn key_changes_from(servers: &[crate::models::Server]) -> HashMap<(String, u16), HostKeyChanges> {
        let mut map: HashMap<(String, u16), HostKeyChanges> = HashMap::new();
        for s in servers {
            if s.host_key_changes == HostKeyChanges::Block {
                continue;
            }
            let entry = map.entry((s.host.trim().to_ascii_lowercase(), s.port)).or_default();
            *entry = (*entry).max(s.host_key_changes);
        }
        map
    }

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
            key_changes: Arc::new(HashMap::new()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::Server;

    fn server(host: &str, port: u16, changes: &str) -> Server {
        serde_json::from_value(serde_json::json!({
            "name": host, "host": host, "port": port, "host_key_changes": changes,
        }))
        .unwrap()
    }

    #[test]
    fn a_host_with_no_setting_blocks_changed_keys() {
        let old: Server = serde_json::from_value(serde_json::json!({
            "name": "pi", "host": "pi.local", "port": 22,
        }))
        .unwrap();
        assert_eq!(old.host_key_changes, HostKeyChanges::Block);
        // An unknown value, from a newer build, falls back the safe way.
        assert_eq!(server("pi.local", 22, "whatever").host_key_changes, HostKeyChanges::Block);
        assert_eq!(server("pi.local", 22, "auto").host_key_changes, HostKeyChanges::Auto);
    }

    #[test]
    fn the_setting_belongs_to_the_address() {
        let map = ConnectSecurity::key_changes_from(&[
            server("Pi.local", 22, "ask"),
            server("pi.local", 22, "auto"),
            server("pi.local", 2222, "block"),
            server("other.local", 22, "ask"),
        ]);
        // Two records for one address: the more permissive one wins.
        assert_eq!(map.get(&("pi.local".into(), 22)), Some(&HostKeyChanges::Auto));
        // Another port is another host, and Block is not stored at all.
        assert_eq!(map.get(&("pi.local".into(), 2222)), None);
        assert_eq!(map.get(&("other.local".into(), 22)), Some(&HostKeyChanges::Ask));
    }
}
