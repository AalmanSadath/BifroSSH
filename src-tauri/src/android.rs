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
