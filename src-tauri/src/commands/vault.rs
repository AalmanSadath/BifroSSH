use tauri::{AppHandle, State};


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
    /// Fingerprint unlock is turned on (Android).
    pub biometric: bool,
    /// An app PIN is set (Android).
    pub pin: bool,
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
    let dir = crate::store::get_data_dir().ok();
    Ok(VaultStatus {
        locked,
        setup_required,
        keyring_available: matches!(keyring, crate::keyring::KeyringStatus::Ready(_)),
        keyring_locked: matches!(keyring, crate::keyring::KeyringStatus::Locked),
        error: state.startup_error.clone(),
        biometric: dir.as_deref().is_some_and(crate::keystore::has_biometric),
        pin: dir.as_deref().is_some_and(crate::keystore::has_pin),
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
    open_with_key(&state, key).await
}

/// Loads the data with a key that just opened the keystore, then publishes
/// the key.
///
/// Load first, so a data file that will not open leaves the app locked rather
/// than half started with an empty AppData that the next save would write
/// over the real one.
async fn open_with_key(state: &AppState, key: [u8; 32]) -> CmdResult<()> {
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
#[cfg(not(target_os = "android"))]
pub const LOCK_NEEDS_PASSPHRASE: &str =
    "Set a master passphrase to enable locking. Without one the keyring would reopen the vault by itself.";
/// Android has no keyring; the key would be sitting in the app's storage.
#[cfg(target_os = "android")]
pub const LOCK_NEEDS_PASSPHRASE: &str =
    "Set a master passphrase to enable locking. Without one there is nothing to unlock it with.";

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
    // A sudo password is a secret too, and a locked app keeps none.
    state.container_state.sudo.lock().await.clear();
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
    pub biometric_enabled: bool,
    pub pin_enabled: bool,
    /// Whether this phone can do fingerprint unlock at all, and if not why.
    /// Always false off Android.
    pub biometric_available: bool,
    pub biometric_reason: Option<String>,
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
pub async fn keystore_status(app: AppHandle, _state: State<'_, AppState>) -> CmdResult<KeystoreStatus> {
    let dir = crate::store::get_data_dir()?;
    let keyring = crate::keyring::keyring_status();
    let keyring_available = matches!(keyring, crate::keyring::KeyringStatus::Ready(_));
    let (biometric_available, biometric_reason) = biometric_availability(&app);
    Ok(KeystoreStatus {
        source: crate::keystore::current_source(&dir, keyring_available),
        biometric_enabled: crate::keystore::has_biometric(&dir),
        pin_enabled: crate::keystore::has_pin(&dir),
        biometric_available,
        biometric_reason,
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
    app: AppHandle,
    state: State<'_, AppState>,
) -> CmdResult<()> {
    let dir = crate::store::get_data_dir()?;
    let key = check_passphrase(&dir, &passphrase, &state)?;
    let had_quick = crate::keystore::has_biometric(&dir) || crate::keystore::has_pin(&dir);
    crate::keystore::clear_passphrase(&dir, &key).map_err(CmdError::from)?;
    // Fingerprint and PIN went with it; their hardware keys go too.
    if had_quick {
        hw::biometric_remove(&app);
        hw::pin_remove(&app);
    }
    Ok(())
}

/// The master key, if `passphrase` is this keystore's and opens to the key in
/// use. What anything that adds or removes a way in asks for, so that someone
/// at an unlocked screen cannot change who can get in.
fn check_passphrase(dir: &std::path::Path, passphrase: &str, state: &AppState) -> CmdResult<[u8; 32]> {
    let key = crate::keystore::unlock_with_passphrase(dir, passphrase)?;
    if key != state.key()? {
        return Err("That passphrase does not match this keystore".to_string().into());
    }
    Ok(key)
}

// ── Fingerprint and app PIN (Android) ───────────────────────────────────────
//
// Both sit beside the master passphrase, never instead of it: keystore.rs
// refuses them without one. Turning either on asks for the passphrase;
// turning one off asks for nothing, since it only takes a way in away.

/// Opens the vault with a fingerprint. False when the prompt was cancelled,
/// which is not an error worth showing.
#[tauri::command]
pub async fn unlock_vault_biometric(app: AppHandle, state: State<'_, AppState>) -> CmdResult<bool> {
    if state.secret_key.is_set() {
        return Ok(true);
    }
    let dir = crate::store::get_data_dir()?;
    let wrapper = crate::keystore::biometric_wrapper(&dir)
        .ok_or_else(|| "Fingerprint unlock is not turned on".to_string())?;
    match hw::biometric_decrypt(&app, &dir, &wrapper).await? {
        Some(key) => open_with_key(&state, key).await.map(|_| true),
        None => Ok(false),
    }
}

#[derive(serde::Serialize)]
#[serde(tag = "result", rename_all = "kebab-case")]
pub enum PinAttempt {
    Opened,
    Wrong { tries_left: u32 },
    /// Out of tries: the PIN is gone and the passphrase is the way in.
    Disabled,
}

#[tauri::command]
pub async fn unlock_vault_pin(pin: String, app: AppHandle, state: State<'_, AppState>) -> CmdResult<PinAttempt> {
    if state.secret_key.is_set() {
        return Ok(PinAttempt::Opened);
    }
    let dir = crate::store::get_data_dir()?;
    let mac = |x: &[u8; 32]| hw::pin_mac(&app, x);
    match crate::keystore::unlock_with_pin(&dir, &pin, &mac)? {
        crate::keystore::PinOutcome::Opened(key) => {
            open_with_key(&state, key).await?;
            Ok(PinAttempt::Opened)
        }
        crate::keystore::PinOutcome::Wrong { tries_left } => Ok(PinAttempt::Wrong { tries_left }),
        crate::keystore::PinOutcome::Disabled => {
            hw::pin_remove(&app);
            Ok(PinAttempt::Disabled)
        }
    }
}

/// Turns fingerprint unlock on. False when the prompt was cancelled.
#[tauri::command]
pub async fn enable_biometric(passphrase: String, app: AppHandle, state: State<'_, AppState>) -> CmdResult<bool> {
    let dir = crate::store::get_data_dir()?;
    let key = check_passphrase(&dir, &passphrase, &state)?;
    let Some(wrapper) = hw::biometric_encrypt(&app, &key).await? else {
        return Ok(false);
    };
    crate::keystore::set_biometric(&dir, wrapper)?;
    Ok(true)
}

#[tauri::command]
pub async fn disable_biometric(app: AppHandle) -> CmdResult<()> {
    let dir = crate::store::get_data_dir()?;
    crate::keystore::clear_biometric(&dir)?;
    hw::biometric_remove(&app);
    Ok(())
}

/// Sets or changes the app PIN.
#[tauri::command]
pub async fn set_app_pin(passphrase: String, pin: String, app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    crate::keystore::check_pin(&pin)?;
    let dir = crate::store::get_data_dir()?;
    let key = check_passphrase(&dir, &passphrase, &state)?;
    let mac = |x: &[u8; 32]| hw::pin_mac(&app, x);
    crate::keystore::set_pin(&dir, &key, &pin, &mac).map_err(CmdError::from)
}

#[tauri::command]
pub async fn remove_app_pin(app: AppHandle) -> CmdResult<()> {
    let dir = crate::store::get_data_dir()?;
    crate::keystore::clear_pin(&dir)?;
    hw::pin_remove(&app);
    Ok(())
}

fn biometric_availability(app: &AppHandle) -> (bool, Option<String>) {
    #[cfg(target_os = "android")]
    {
        let s = crate::android::biometric_status(app);
        (s.available, s.reason)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        (false, None)
    }
}

/// The phone's half of fingerprint and PIN, which is the Android Keystore.
/// Elsewhere there is none, and each of these says so.
mod hw {
    use tauri::AppHandle;

    #[cfg(not(target_os = "android"))]
    const ONLY_ANDROID: &str = "Fingerprint and PIN unlock are only on Android";

    /// None when the prompt was cancelled.
    pub async fn biometric_encrypt(
        app: &AppHandle,
        key: &[u8; 32],
    ) -> Result<Option<crate::keystore::BiometricWrapper>, String> {
        #[cfg(target_os = "android")]
        {
            match crate::android::biometric_encrypt(app, key).await {
                Ok(w) => Ok(Some(w)),
                Err(crate::android::BiometricError::Cancelled) => Ok(None),
                Err(e) => Err(e.to_string()),
            }
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = (app, key);
            Err(ONLY_ANDROID.into())
        }
    }

    /// None when the prompt was cancelled. A key Android has destroyed,
    /// because the fingerprints changed, takes its wrapper with it.
    pub async fn biometric_decrypt(
        app: &AppHandle,
        dir: &std::path::Path,
        wrapper: &crate::keystore::BiometricWrapper,
    ) -> Result<Option<[u8; 32]>, String> {
        #[cfg(target_os = "android")]
        {
            match crate::android::biometric_decrypt(app, wrapper).await {
                Ok(k) => Ok(Some(k)),
                Err(crate::android::BiometricError::Cancelled) => Ok(None),
                Err(e @ crate::android::BiometricError::Invalidated) => {
                    let _ = crate::keystore::clear_biometric(dir);
                    Err(e.to_string())
                }
                Err(e) => Err(e.to_string()),
            }
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = (app, dir, wrapper);
            Err(ONLY_ANDROID.into())
        }
    }

    pub fn biometric_remove(app: &AppHandle) {
        #[cfg(target_os = "android")]
        crate::android::biometric_remove(app);
        #[cfg(not(target_os = "android"))]
        let _ = app;
    }

    pub fn pin_mac(app: &AppHandle, input: &[u8; 32]) -> anyhow::Result<[u8; 32]> {
        #[cfg(target_os = "android")]
        {
            crate::android::pin_mac(app, input)
        }
        #[cfg(not(target_os = "android"))]
        {
            let _ = (app, input);
            Err(anyhow::anyhow!(ONLY_ANDROID))
        }
    }

    pub fn pin_remove(app: &AppHandle) {
        #[cfg(target_os = "android")]
        crate::android::pin_remove(app);
        #[cfg(not(target_os = "android"))]
        let _ = app;
    }
}
