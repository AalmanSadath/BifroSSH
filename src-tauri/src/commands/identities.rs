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

    // Neither of these authenticates with anything this could keep: prompts are
    // answered per connection and the agent holds its own keys. Leaving a
    // password behind would mean a secret surviving a change the user made to
    // stop using it.
    let stores_nothing = matches!(
        identity.auth_kind,
        Some(AuthKind::KeyboardInteractive) | Some(AuthKind::Agent)
    );
    if stores_nothing {
        identity.encrypted_password = None;
        identity.key_id = None;
    } else if let Some(pw) = password.as_deref().filter(|p| !p.is_empty()) {
        // An empty box means no password, the same as it does for a server.
        // Encrypting it instead stored a credential that was not one, and
        // get_identity_password then handed back "" rather than saying there
        // was nothing to hand back.
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
    super::records::forget_references_to(&mut data, &identity_id);
    state.save(&data)
}
