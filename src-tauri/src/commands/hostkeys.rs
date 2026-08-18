use tauri::State;

use crate::hostkeys::{self, KnownHostEntry};
use crate::prompts::HostKeyDecision;

use super::{CmdError, CmdResult};
use super::AppState;

// ── Host keys ────────────────────────────────────────────────────────────────

/// Completes a host key prompt. The connect is parked on the matching oneshot.
#[tauri::command]
pub async fn respond_host_key(
    state: State<'_, AppState>,
    request_id: String,
    decision: String,
) -> CmdResult<()> {
    let decision = HostKeyDecision::from_str(&decision)
        .ok_or_else(|| format!("Unknown host key decision: {}", decision))?;

    let sender = state.prompts.host_keys.lock().await.remove(&request_id);
    // A missing entry means the connect already gave up (timeout, or the user
    // closed the session). Nothing to answer, and not an error worth surfacing.
    if let Some(sender) = sender {
        let _ = sender.send(decision);
    }

    Ok(())
}

/// Completes a keyboard-interactive round. `None` cancels the login.
#[tauri::command]
pub async fn respond_auth_prompt(
    state: State<'_, AppState>,
    request_id: String,
    responses: Option<Vec<String>>,
) -> CmdResult<()> {
    let sender = state.prompts.auth.lock().await.remove(&request_id);
    // Gone means the connect already gave up; nothing left to answer.
    if let Some(sender) = sender {
        let _ = sender.send(responses);
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub struct AgentKeyInfo {
    pub algorithm: String,
    pub fingerprint: String,
}

/// Keys currently held by the running ssh-agent.
///
/// No comment field: the agent protocol carries one, but russh-keys discards it
/// while parsing, so there is no `user@host` label to show.
#[tauri::command]
pub async fn list_agent_keys() -> CmdResult<Vec<AgentKeyInfo>> {
    #[cfg(unix)]
    {
        use russh_keys::agent::client::AgentClient;

        let mut agent = AgentClient::connect_env().await.map_err(|e| {
            format!("Could not reach ssh-agent ({}). Check that an agent is running and SSH_AUTH_SOCK is set.", e)
        })?;

        let identities = agent
            .request_identities()
            .await
            .map_err(|e| format!("Could not list ssh-agent keys: {}", e))?;

        Ok(identities
            .iter()
            .map(|key| AgentKeyInfo {
                algorithm: key.name().to_string(),
                fingerprint: hostkeys::fingerprint(key),
            })
            .collect())
    }
    #[cfg(not(unix))]
    {
        Err("ssh-agent is only supported on Unix".to_string().into())
    }
}

#[tauri::command]
pub async fn list_known_hosts() -> CmdResult<Vec<KnownHostEntry>> {
    hostkeys::list_known_hosts().map_err(CmdError::from)
}

#[tauri::command]
pub async fn forget_known_host(host: String, port: u16) -> CmdResult<()> {
    hostkeys::forget_host(&host, port)
        .map(|_| ())
        .map_err(CmdError::from)
}
