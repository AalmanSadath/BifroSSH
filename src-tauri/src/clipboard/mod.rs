//! The system clipboard as text, read by the backend rather than the webview.
//!
//! The webview can already read the clipboard, and for a keyboard paste it
//! should: `navigator.clipboard.readText()` is the shorter path and the one
//! the browser is happy with. It refuses when there is no user activation,
//! and a right click is not user activation on either engine, so a
//! right-click-to-paste has to ask someone else.
//!
//! Two backends, one shape, both using a library the app already links. On
//! Linux that is GTK's own clipboard: it is the toolkit the webview is
//! running in, so it answers on Wayland and X11 alike and it answers from
//! inside the Flatpak sandbox, where the manifest grants `--socket=wayland`
//! and only `--socket=fallback-x11`. An X11-only clipboard library would read
//! nothing at all on a Wayland session there. On Windows it is the same
//! `windows` crate the keyring and the theme already use.
//!
//! Reading is all this does. Writing stays in the webview, where
//! `navigator.clipboard.writeText()` works without a gesture.

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
    pub(super) fn read_text(_app: &tauri::AppHandle) -> Result<String, String> {
        Err("Reading the clipboard is not supported on this platform".into())
    }
}

/// The clipboard's text, or an empty string when it holds something else.
///
/// Blocking: the Linux backend waits on the GTK main thread and the Windows
/// one waits on the clipboard lock. Call it from `spawn_blocking`.
pub fn read_text(app: &AppHandle) -> Result<String, String> {
    backend::read_text(app)
}
