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
