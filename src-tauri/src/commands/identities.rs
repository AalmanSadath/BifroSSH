use tauri::State;
use uuid::Uuid;

use crate::crypto::{decrypt, encrypt};
use crate::models::*;
use crate::store::save_app_data;

use super::AppState;

// ── Identities ───────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn list_identities(state: State<'_, AppState>) -> Result<Vec<Identity>, String> {
    Ok(state.data.lock().await.identities.iter().map(|i| Identity {
        encrypted_password: i.encrypted_password.as_ref().map(|_| "[stored]".to_string()),
        ..i.clone()
    }).collect())
}

#[tauri::command]
pub async fn save_identity(
    state: State<'_, AppState>,
    identity: Identity,
    password: Option<String>,
) -> Result<Identity, String> {
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
        identity.encrypted_password = Some(encrypt(pw.as_bytes(), &state.key()?).map_err(|e| e.to_string())?);
    } else if identity.key_id.is_some() {
        identity.encrypted_password = None;
    } else {
        let existing_pw = data.identities.iter().find(|i| i.id == identity.id)
            .and_then(|i| i.encrypted_password.clone());
        identity.encrypted_password = existing_pw;
    }

    match data.identities.iter().position(|i| i.id == identity.id) {
        Some(idx) => data.identities[idx] = identity.clone(),
        None => data.identities.push(identity.clone()),
    }
    save_app_data(&data, &state.key()?).map_err(|e| e.to_string())?;
    Ok(Identity {
        encrypted_password: identity.encrypted_password.map(|_| "[stored]".to_string()),
        ..identity
    })
}

#[tauri::command]
pub async fn get_identity_password(
    state: State<'_, AppState>,
    identity_id: String,
) -> Result<String, String> {
    let data = state.data.lock().await;
    let identity = data.identities.iter().find(|i| i.id == identity_id)
        .ok_or("Identity not found")?;
    let enc = identity.encrypted_password.as_ref().ok_or("No password stored for this identity")?;
    let bytes = decrypt(enc, &state.key()?).map_err(|e| e.to_string())?;
    String::from_utf8(bytes).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_identity(
    state: State<'_, AppState>,
    identity_id: String,
) -> Result<(), String> {
    let mut data = state.data.lock().await;
    data.identities.retain(|i| i.id != identity_id);
    for server in data.servers.iter_mut() {
        if server.identity_id.as_deref() == Some(&identity_id) {
            server.identity_id = None;
        }
    }
    save_app_data(&data, &state.key()?).map_err(|e| e.to_string())
}
