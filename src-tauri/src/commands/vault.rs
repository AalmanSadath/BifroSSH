use tauri::State;


use super::{CmdError, CmdResult};
use super::AppState;

// ── Master key ──────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct VaultStatus {
    pub locked: bool,
    /// No key has ever been made for this profile, so the user picks how it
    /// should be kept before anything is written.
    pub setup_required: bool,
    /// Whether a keyring answered, which decides if the keyring option can be
    /// offered at all.
    pub keyring_available: bool,
    /// The keyring is there and holds our key, but will not open. Distinct
    /// from unavailable: the passphrase is being asked for because of
    /// something the user can undo by unlocking their keyring.
    pub keyring_locked: bool,
    /// Set when the keystore could not be opened at all, in which case no
    /// passphrase will help and the message says why.
    pub error: Option<String>,
}

#[tauri::command]
pub async fn vault_status(state: State<'_, AppState>) -> CmdResult<VaultStatus> {
    let locked = !state.secret_key.is_set();
    let setup_required = locked
        && state.startup_error.is_none()
        && crate::store::get_data_dir()
            .map(|dir| crate::keystore::is_first_run(&dir))
            .unwrap_or(false);

    // Only worth the D-Bus round trip while something is going to be said
    // about it, which is the setup screen and the unlock screen.
    let keyring = if locked {
        crate::keyring::keyring_status()
    } else {
        crate::keyring::KeyringStatus::Missing
    };
    Ok(VaultStatus {
        locked,
        setup_required,
        keyring_available: matches!(keyring, crate::keyring::KeyringStatus::Ready(_)),
        keyring_locked: matches!(keyring, crate::keyring::KeyringStatus::Locked),
        error: state.startup_error.clone(),
    })
}

/// A fresh word phrase for the dice button. Generated in the backend so the
/// randomness comes from the same source as the keys themselves.
#[tauri::command]
pub async fn generate_passphrase() -> CmdResult<String> {
    Ok(crate::keystore::generate_passphrase())
}

/// Creates the master key the way the first run screen asked for.
#[tauri::command]
pub async fn initialize_vault(
    mode: crate::keystore::InitMode,
    passphrase: String,
    state: State<'_, AppState>,
) -> CmdResult<()> {
    if state.secret_key.is_set() {
        return Err("This profile already has a key".to_string().into());
    }
    let dir = crate::store::get_data_dir()?;
    if !crate::keystore::is_first_run(&dir) {
        return Err("This profile already has a key".to_string().into());
    }
    let key = crate::keystore::initialize(&dir, mode, &passphrase)?;
    state.secret_key.set(key);
    Ok(())
}

/// Opens the vault and loads the data that could not be read until now.
#[tauri::command]
pub async fn unlock_vault(passphrase: String, state: State<'_, AppState>) -> CmdResult<()> {
    if state.secret_key.is_set() {
        return Ok(());
    }
    let dir = crate::store::get_data_dir()?;
    let key = crate::keystore::unlock_with_passphrase(&dir, &passphrase)?;

    // Load before publishing the key, so a data file that will not open leaves
    // the app locked rather than half started with an empty AppData that the
    // next save would write over the real one.
    let loaded = crate::store::load_app_data(&key)?;
    *state.data.lock().await = loaded;
    state.secret_key.set(key);
    Ok(())
}

/// Closes the vault: the key is zeroed and dropped and the data with it, so
/// from here every command fails the way it does before the first unlock.
/// Sessions and tunnels already open stay open, the way a screen lock over a
/// shell leaves the shell running; the key was used at connect time and is
/// not what they run on.
///
/// Refused while no passphrase is set. The keyring would hand the key
/// straight back on the next unlock without asking anyone, and a lock that
/// anyone at the desk can undo with a click is a hidden window, not a lock.
pub const LOCK_NEEDS_PASSPHRASE: &str =
    "Set a master passphrase to enable locking. Without one the keyring would reopen the vault by itself.";

pub async fn close_vault(state: &AppState, app: &tauri::AppHandle) -> CmdResult<()> {
    if !state.secret_key.is_set() {
        return Ok(());
    }
    let dir = crate::store::get_data_dir()?;
    if !crate::keystore::has_passphrase(&dir) {
        return Err(LOCK_NEEDS_PASSPHRASE.into());
    }
    // Data first, then the key: a command racing this sees either the real
    // data with a key or nothing with nothing, never empty data with a key
    // it could save.
    *state.data.lock().await = crate::models::AppData::default();
    state.secret_key.clear();
    use tauri::Emitter;
    let _ = app.emit("vault-locked", ());
    Ok(())
}

#[tauri::command]
pub async fn lock_vault(state: State<'_, AppState>, app: tauri::AppHandle) -> CmdResult<()> {
    close_vault(&state, &app).await
}

#[derive(serde::Serialize)]
pub struct KeystoreStatus {
    pub source: crate::keystore::KeySource,
    pub passphrase_set: bool,
    /// When set, the keyring is not allowed to open the vault and the
    /// passphrase is demanded at every launch.
    pub always_ask: bool,
    /// Whether a keyring answered just now. Distinct from `source`, which is
    /// how the key was found at startup: a keyring can appear or disappear
    /// between launches.
    pub keyring_available: bool,
    /// Present but locked, which is the user's to fix and not a fault here.
    pub keyring_locked: bool,
}

#[tauri::command]
pub async fn keystore_status(_state: State<'_, AppState>) -> CmdResult<KeystoreStatus> {
    let dir = crate::store::get_data_dir()?;
    let keyring = crate::keyring::keyring_status();
    let keyring_available = matches!(keyring, crate::keyring::KeyringStatus::Ready(_));
    Ok(KeystoreStatus {
        source: crate::keystore::current_source(&dir, keyring_available),
        keyring_locked: matches!(keyring, crate::keyring::KeyringStatus::Locked),
        passphrase_set: crate::keystore::has_passphrase(&dir),
        always_ask: crate::keystore::always_asks(&dir),
        keyring_available,
    })
}

/// Adds a passphrase and removes .secret. With `always_ask` the keyring copy
/// goes too. Takes effect at the next launch, since the key is already in
/// memory for this one.
#[tauri::command]
pub async fn set_master_passphrase(
    passphrase: String,
    always_ask: bool,
    state: State<'_, AppState>,
) -> CmdResult<()> {
    let dir = crate::store::get_data_dir()?;
    let form = crate::keystore::detect_form(&passphrase);
    crate::keystore::set_passphrase(&dir, &state.key()?, &passphrase, always_ask, form)
        .map_err(CmdError::from)
}

/// Switches between the keyring being allowed to open the vault and the
/// passphrase being required every time.
#[tauri::command]
pub async fn set_always_ask(
    always_ask: bool,
    state: State<'_, AppState>,
) -> CmdResult<()> {
    let dir = crate::store::get_data_dir()?;
    crate::keystore::set_always_ask(&dir, &state.key()?, always_ask)
        .map_err(CmdError::from)
}

/// Requires the current passphrase, so that someone at an unlocked screen
/// cannot quietly turn the protection off.
#[tauri::command]
pub async fn remove_master_passphrase(
    passphrase: String,
    state: State<'_, AppState>,
) -> CmdResult<()> {
    let dir = crate::store::get_data_dir()?;
    let key = crate::keystore::unlock_with_passphrase(&dir, &passphrase)?;
    if key != state.key()? {
        return Err("That passphrase does not match this keystore".to_string().into());
    }
    crate::keystore::clear_passphrase(&dir, &state.key()?).map_err(CmdError::from)
}
