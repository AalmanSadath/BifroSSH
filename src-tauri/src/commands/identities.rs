use tauri::State;
use uuid::Uuid;

use crate::models::*;

use super::records::*;
use super::CmdResult;
use super::AppState;

// ── Identities ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_identities(state: State<'_, AppState>) -> CmdResult<Vec<Identity>> {
    Ok(state.data.lock().await.identities.iter().cloned().map(Redacted::redacted).collect())
}

#[tauri::command]
pub async fn save_identity(
    state: State<'_, AppState>,
    identity: Identity,
    password: Option<String>,
) -> CmdResult<Identity> {
    let mut data = state.data.lock().await;
    let mut identity = if identity.id.is_empty() {
        Identity { id: Uuid::new_v4().to_string(), ..identity }
    } else {
        identity
    };

    let uses_prompts = identity.auth_kind.as_deref() == Some("keyboard-interactive");
    if uses_prompts {
        // Answered per connection, never stored.
        identity.encrypted_password = None;
        identity.key_id = None;
    } else if let Some(ref pw) = password {
        identity.encrypted_password = Some(state.encrypt(pw.as_bytes())?);
    } else if identity.key_id.is_some() {
        identity.encrypted_password = None;
    } else {
        let existing_pw = find_by_id(&data.identities, &identity.id)
            .and_then(|i| i.encrypted_password.clone());
        identity.encrypted_password = existing_pw;
    }

    upsert_by_id(&mut data.identities, identity.clone());
    state.save(&data)?;
    Ok(identity.redacted())
}

#[tauri::command]
pub async fn get_identity_password(
    state: State<'_, AppState>,
    identity_id: String,
) -> CmdResult<String> {
    let data = state.data.lock().await;
    let identity = find_by_id(&data.identities, &identity_id)
        .ok_or("Identity not found")?;
    let enc = identity.encrypted_password.as_ref().ok_or("No password stored for this identity")?;
    state.decrypt_str(enc)
}

#[tauri::command]
pub async fn delete_identity(
    state: State<'_, AppState>,
    identity_id: String,
) -> CmdResult<()> {
    let mut data = state.data.lock().await;
    data.identities.retain(|i| i.id != identity_id);
    for server in data.servers.iter_mut() {
        if server.identity_id.as_deref() == Some(&identity_id) {
            server.identity_id = None;
        }
    }
    state.save(&data)
}
