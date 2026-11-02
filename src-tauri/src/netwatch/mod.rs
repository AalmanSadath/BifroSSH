//! Telling the page that the network changed, so connections left on the
//! old one are found and brought back at once.
//!
//! Two backends, one shape, the way `suspend` is built. Each parks a watcher
//! on the platform's own "the network changed" notification and calls
//! `notify`. Waking from sleep calls it too, from `suspend`: a laptop that
//! slept through its connections dying would otherwise wait for keepalives
//! to give up on each one, which takes about a minute and a half.
//!
//! On Linux it is the network monitor portal on the session bus, which needs
//! no Flatpak permission and is there outside Flatpak as well. On Windows it
//! is an address change callback from the IP helper API.
//!
//! What to do about it is the page's business (`useNetworkChange`): the same
//! check-and-retry Android runs when its default network changes.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use tauri::{AppHandle, Emitter};

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

/// How long the network has to stay quiet before the page is told. One
/// change is several notifications (an address goes, a route goes, another
/// address comes), and acting on the first would check connections on a
/// network that is still coming up.
#[cfg_attr(not(any(target_os = "linux", windows)), allow(dead_code))]
const SETTLE: Duration = Duration::from_secs(1);

#[cfg_attr(not(any(target_os = "linux", windows)), allow(dead_code))]
static LATEST: AtomicU64 = AtomicU64::new(0);

/// The network changed, or the machine woke up. Tells the main window once
/// things have been quiet for `SETTLE`.
#[cfg_attr(not(any(target_os = "linux", windows)), allow(dead_code))]
pub(crate) fn notify(app: &AppHandle) {
    let mine = LATEST.fetch_add(1, Ordering::SeqCst) + 1;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SETTLE).await;
        if LATEST.load(Ordering::SeqCst) == mine {
            let _ = app.emit_to("main", "network-changed", ());
        }
    });
}
