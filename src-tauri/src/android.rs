//! The app's own Android plugin: the Kotlin side is `AndroidPlugin.kt` in
//! gen/android, for what only the Activity can reach.

use serde::Deserialize;
use tauri::plugin::{Builder, PluginHandle, TauriPlugin};
use tauri::{AppHandle, Manager, Wry};

struct Android(PluginHandle<Wry>);

pub fn init() -> TauriPlugin<Wry> {
    Builder::new("bifrossh-android")
        .setup(|app, api| {
            let handle = api.register_android_plugin("io.github.aalmansadath.bifrossh", "AndroidPlugin")?;
            app.manage(Android(handle));
            Ok(())
        })
        .build()
}

#[derive(Deserialize)]
struct Text {
    text: String,
}

/// The clipboard as text, empty when it holds anything else.
pub fn read_clipboard(app: &AppHandle) -> Result<String, String> {
    app.state::<Android>()
        .0
        .run_mobile_plugin::<Text>("readClipboard", ())
        .map(|t| t.text)
        .map_err(|e| e.to_string())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Appearance {
    color_scheme: String,
    accent: Option<String>,
}

/// Night mode, and the Material You accent from Android 12 on. No preference
/// and no accent if the Activity cannot be asked.
pub fn system_appearance(app: &AppHandle) -> crate::appearance::SystemAppearance {
    match app.state::<Android>().0.run_mobile_plugin::<Appearance>("systemAppearance", ()) {
        Ok(a) => crate::appearance::SystemAppearance { color_scheme: a.color_scheme, accent: a.accent },
        Err(_) => crate::appearance::SystemAppearance {
            color_scheme: "no-preference".into(),
            accent: None,
        },
    }
}

#[derive(Deserialize)]
struct Granted {
    granted: bool,
}

/// Whether shared storage can be used by path. False if it cannot be asked.
pub fn storage_access(app: &AppHandle) -> bool {
    app.state::<Android>()
        .0
        .run_mobile_plugin::<Granted>("storageAccess", ())
        .map(|g| g.granted)
        .unwrap_or(false)
}

/// Opens the system page that grants it. The answer is read again later,
/// when the app comes back to the front.
pub fn request_storage_access(app: &AppHandle) -> Result<(), String> {
    app.state::<Android>()
        .0
        .run_mobile_plugin::<()>("requestStorageAccess", ())
        .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct KeepAlive {
    count: u32,
    wake_lock: bool,
}

/// Starts, updates or, at 0, stops the service that keeps the process and
/// its connections alive in the background.
pub fn keep_alive(app: &AppHandle, count: u32, wake_lock: bool) -> Result<(), String> {
    app.state::<Android>()
        .0
        .run_mobile_plugin::<()>("keepAlive", KeepAlive { count, wake_lock })
        .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct Enabled {
    enabled: bool,
}

/// Whether the volume keys change the terminal's text size.
pub fn volume_keys(app: &AppHandle, enabled: bool) -> Result<(), String> {
    app.state::<Android>()
        .0
        .run_mobile_plugin::<()>("volumeKeys", Enabled { enabled })
        .map_err(|e| e.to_string())
}

// ── Launches ─────────────────────────────────────────────────────────────────

/// What the app was opened for from outside: a launcher shortcut, an
/// `ssh://` link, or text shared from another app. Kept by MainActivity until
/// the page is ready to act on it.
#[derive(Deserialize, serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Launch {
    Host { id: String },
    Ssh { url: String },
    Share { text: String },
}

#[derive(Deserialize)]
struct Taken {
    launch: Option<Launch>,
}

/// The launch waiting to be handled, taken so it is handled once.
pub fn take_launch(app: &AppHandle) -> Result<Option<Launch>, String> {
    app.state::<Android>()
        .0
        .run_mobile_plugin::<Taken>("takeLaunch", ())
        .map(|t| t.launch)
        .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct HostShortcut<'a> {
    id: &'a str,
    label: &'a str,
}

/// Puts a host at the top of the launcher icon's shortcuts.
pub fn host_used(app: &AppHandle, id: &str, label: &str) -> Result<(), String> {
    app.state::<Android>()
        .0
        .run_mobile_plugin::<()>("hostUsed", HostShortcut { id, label })
        .map_err(|e| e.to_string())
}

/// Asks the launcher to pin a shortcut to a host on the home screen.
pub fn pin_host(app: &AppHandle, id: &str, label: &str) -> Result<(), String> {
    app.state::<Android>()
        .0
        .run_mobile_plugin::<()>("pinHost", HostShortcut { id, label })
        .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
struct Ids<'a> {
    ids: &'a [String],
}

/// Takes deleted hosts out of the shortcuts, and disables any pinned ones.
pub fn hosts_removed(app: &AppHandle, ids: &[String]) -> Result<(), String> {
    app.state::<Android>()
        .0
        .run_mobile_plugin::<()>("hostsRemoved", Ids { ids })
        .map_err(|e| e.to_string())
}

// ── Fingerprint and PIN ─────────────────────────────────────────────────────
//
// The hardware half of fingerprint and PIN unlock. What to keep and when to
// allow it is decided in keystore.rs; these only reach the Android Keystore.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use tauri::plugin::mobile::PluginInvokeError;

#[derive(Deserialize)]
pub struct BiometricStatus {
    pub available: bool,
    pub reason: Option<String>,
}

/// Whether a fingerprint can be used now, and why not if it cannot.
pub fn biometric_status(app: &AppHandle) -> BiometricStatus {
    app.state::<Android>()
        .0
        .run_mobile_plugin::<BiometricStatus>("biometricStatus", ())
        .unwrap_or(BiometricStatus { available: false, reason: Some("Android could not be asked.".into()) })
}

/// Why a fingerprint prompt did not hand back a key.
#[derive(Debug)]
pub enum BiometricError {
    /// The user closed the prompt.
    Cancelled,
    /// Fingerprints were added or removed since this was turned on, and
    /// Android destroyed the key.
    Invalidated,
    /// Too many unrecognised fingers; Android has paused the sensor.
    Lockout,
    Failed(String),
}

impl std::fmt::Display for BiometricError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled => f.write_str("Cancelled"),
            Self::Invalidated => f.write_str(
                "The fingerprints on this phone changed, so Android switched off fingerprint unlock. \
                 Unlock another way and turn it on again in Settings.",
            ),
            Self::Lockout => f.write_str("Too many tries. Android has paused the fingerprint sensor for now."),
            Self::Failed(m) => write!(f, "Fingerprint unlock failed: {m}"),
        }
    }
}

fn biometric_error(e: PluginInvokeError) -> BiometricError {
    match e {
        PluginInvokeError::InvokeRejected(r) => match r.code.as_deref() {
            Some("cancelled") => BiometricError::Cancelled,
            Some("invalidated") => BiometricError::Invalidated,
            Some("lockout") => BiometricError::Lockout,
            _ => BiometricError::Failed(r.message.unwrap_or_default()),
        },
        other => BiometricError::Failed(other.to_string()),
    }
}

#[derive(serde::Serialize)]
struct DataArgs {
    data: String,
}

#[derive(serde::Serialize, Deserialize)]
struct Sealed {
    iv: String,
    blob: String,
}

/// Encrypts the master key under a new fingerprint-bound key, asking for a
/// fingerprint to do it.
pub async fn biometric_encrypt(
    app: &AppHandle,
    master: &[u8; 32],
) -> Result<crate::keystore::BiometricWrapper, BiometricError> {
    let android = app.state::<Android>();
    let sealed: Sealed = android
        .0
        .run_mobile_plugin_async("biometricEncrypt", DataArgs { data: BASE64.encode(master) })
        .await
        .map_err(biometric_error)?;
    Ok(crate::keystore::BiometricWrapper { iv: sealed.iv, blob: sealed.blob })
}

#[derive(Deserialize)]
struct Data {
    data: String,
}

/// The master key back from what `biometric_encrypt` made, after a
/// fingerprint.
pub async fn biometric_decrypt(
    app: &AppHandle,
    wrapper: &crate::keystore::BiometricWrapper,
) -> Result<[u8; 32], BiometricError> {
    let android = app.state::<Android>();
    let out: Data = android
        .0
        .run_mobile_plugin_async("biometricDecrypt", Sealed { iv: wrapper.iv.clone(), blob: wrapper.blob.clone() })
        .await
        .map_err(biometric_error)?;
    BASE64
        .decode(out.data)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| BiometricError::Failed("the key came back the wrong size".into()))
}

pub fn biometric_remove(app: &AppHandle) {
    let _ = app.state::<Android>().0.run_mobile_plugin::<()>("biometricRemove", ());
}

#[derive(Deserialize)]
struct Mac {
    mac: String,
}

/// HMAC-SHA256 under the PIN key in the phone's secure hardware.
pub fn pin_mac(app: &AppHandle, input: &[u8; 32]) -> anyhow::Result<[u8; 32]> {
    let out: Mac = app
        .state::<Android>()
        .0
        .run_mobile_plugin("pinMac", DataArgs { data: BASE64.encode(input) })
        .map_err(|e| anyhow::anyhow!("The phone's secure hardware did not answer: {e}"))?;
    BASE64
        .decode(out.mac)
        .ok()
        .and_then(|b| b.try_into().ok())
        .ok_or_else(|| anyhow::anyhow!("The PIN key gave an answer of the wrong size"))
}

pub fn pin_remove(app: &AppHandle) {
    let _ = app.state::<Android>().0.run_mobile_plugin::<()>("pinRemove", ());
}
