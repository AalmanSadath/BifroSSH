//! What the desktop says it looks like: light or dark, and its accent colour.
//!
//! Two backends, one shape. On Linux the answer comes from the XDG desktop
//! portal rather than gsettings or the GTK theme, because the portal is the
//! only source that answers from inside the Flatpak sandbox, where dconf is not
//! visible, and it is the same answer on the desktops that are not GNOME. On
//! Windows it comes from the two registry values the shell itself reads.
//!
//! Both values are advisory. A platform that reports nothing is not an error:
//! it means the app falls back to its own theme and its own accent, which is
//! what it did before any of this existed.

use serde::Serialize;

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as backend;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as backend;

#[cfg(not(any(unix, windows)))]
mod backend {
    pub(super) fn read() -> super::SystemAppearance {
        super::SystemAppearance::default()
    }
    pub(super) fn watch(_app: tauri::AppHandle) {}
}

/// What the desktop reports, as far as it reports anything.
#[derive(Serialize, Clone, Debug, Default, PartialEq)]
pub struct SystemAppearance {
    /// "dark", "light", or "no-preference" when the desktop has no opinion or
    /// cannot be asked.
    pub color_scheme: String,
    /// `#rrggbb`, or None when the desktop exposes no accent. GNOME has had
    /// one since 47; older desktops and most others have not.
    pub accent: Option<String>,
}

/// Reads both values, blocking.
///
/// Never fails: a desktop that cannot be asked is reported as having no
/// preference and no accent, which the frontend already has to handle.
pub fn read() -> SystemAppearance {
    backend::read()
}

/// Name of the event the frontend listens on for a desktop that changed its
/// mind. Payload is a [`SystemAppearance`].
pub const CHANGED_EVENT: &str = "system-appearance-changed";

/// Watches for changes and reports every one for as long as the app runs.
///
/// Failing to start is survivable: the theme still resolves on launch and
/// whenever settings are read, it just stops following the desktop live.
pub fn watch(app: tauri::AppHandle) {
    backend::watch(app)
}
