//! Locking the vault before the machine sleeps.
//!
//! Two backends, one shape, the way `appearance` is built. Each parks a
//! watcher on the platform's own "about to sleep" notification and calls
//! `on_suspend`, which is where the setting is read and the lock happens.
//! Before sleep rather than after resume: what is on screen when the lid
//! opens is then the unlock screen, and the app was never shown unlocked to
//! whoever opened it.
//!
//! On Linux it is logind's `PrepareForSleep` on the system bus, which the
//! Flatpak manifest grants with `--system-talk-name=org.freedesktop.login1`.
//! On Windows it is a power notification callback.

use tauri::AppHandle;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
use linux as backend;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as backend;

#[cfg(not(any(target_os = "linux", windows)))]
mod backend {
    pub(super) fn watch(_app: tauri::AppHandle) {}
}

pub fn watch(app: AppHandle) {
    backend::watch(app);
}

/// The machine is about to sleep. Locks if the setting says to and there is
/// anything to lock; a vault that is already closed is left alone.
pub(crate) fn on_suspend(app: &AppHandle) {
    use tauri::Manager;
    let state = app.state::<crate::commands::AppState>();
    tauri::async_runtime::block_on(async {
        if !state.secret_key.is_set() {
            return;
        }
        let wanted = state.data.lock().await.settings.lock_on_suspend;
        if wanted {
            // A refusal here is a vault with no passphrase, which the settings
            // screen already says cannot lock. Nothing to add from a thread.
            let _ = crate::commands::close_vault(&state, app).await;
        }
    });
}
