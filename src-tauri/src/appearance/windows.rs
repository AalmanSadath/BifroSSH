//! The Windows backend: the two registry values the shell itself reads.
//!
//! There is no portal and no D-Bus here. `AppsUseLightTheme` under
//! `Themes\Personalize` is what Settings writes when the user picks an app
//! mode, and `AccentColor` under `DWM` is the colour the shell draws with.
//! Explorer, the taskbar and WinUI all read these, so following them is
//! following the system rather than guessing at it.

use std::sync::{Arc, Mutex};

use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    RegCloseKey, RegNotifyChangeKeyValue, RegOpenKeyExW, RegQueryValueExW, HKEY,
    HKEY_CURRENT_USER, KEY_NOTIFY, KEY_READ, REG_NOTIFY_CHANGE_LAST_SET, REG_VALUE_TYPE,
};

use super::SystemAppearance;

/// Where Settings writes the app light/dark choice.
const PERSONALIZE: PCWSTR =
    w!(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Themes\Personalize");
/// Where the shell keeps the accent it draws with.
const DWM: PCWSTR = w!(r"SOFTWARE\Microsoft\Windows\DWM");

/// An owned `HKEY` that closes itself, so an early return in a read cannot
/// leak the handle a watcher thread would otherwise hold for the process
/// lifetime.
struct Key(HKEY);

impl Drop for Key {
    fn drop(&mut self) {
        unsafe {
            let _ = RegCloseKey(self.0);
        }
    }
}

impl Key {
    fn open(subkey: PCWSTR, access: u32) -> Option<Self> {
        let mut handle = HKEY::default();
        let status = unsafe {
            RegOpenKeyExW(
                HKEY_CURRENT_USER,
                subkey,
                None,
                windows::Win32::System::Registry::REG_SAM_FLAGS(access),
                &mut handle,
            )
        };
        (status == ERROR_SUCCESS).then_some(Key(handle))
    }

    /// Reads one REG_DWORD. `None` covers every failure the same way: a value
    /// that is absent, of another type, or unreadable is a system with nothing
    /// to say, not a fault to report.
    fn dword(&self, name: PCWSTR) -> Option<u32> {
        let mut value = 0u32;
        let mut kind = REG_VALUE_TYPE::default();
        let mut size = std::mem::size_of::<u32>() as u32;
        let status = unsafe {
            RegQueryValueExW(
                self.0,
                name,
                None,
                Some(&mut kind),
                Some(&mut value as *mut u32 as *mut u8),
                Some(&mut size),
            )
        };
        (status == ERROR_SUCCESS
            && kind == windows::Win32::System::Registry::REG_DWORD
            && size as usize == std::mem::size_of::<u32>())
        .then_some(value)
    }
}

/// `AppsUseLightTheme` is 1 for light and 0 for dark.
///
/// Absent means light, not no-preference: the value only appears once the user
/// has been through the setting, and a Windows install that has never been
/// touched is light. Reporting no-preference there would leave the app on its
/// own dark default while the desktop around it is white.
fn scheme_name(raw: Option<u32>) -> &'static str {
    match raw {
        Some(0) => "dark",
        _ => "light",
    }
}

/// `AccentColor` is a DWORD in **ABGR** order, not the RGB the name suggests:
/// the low byte is red and the high byte is alpha, which is ignored.
fn hex_from_abgr(raw: u32) -> String {
    let [r, g, b, _a] = raw.to_le_bytes();
    format!("#{r:02x}{g:02x}{b:02x}")
}

pub(super) fn read() -> SystemAppearance {
    let color_scheme = scheme_name(
        Key::open(PERSONALIZE, KEY_READ.0).and_then(|k| k.dword(w!("AppsUseLightTheme"))),
    )
    .to_string();

    let accent = Key::open(DWM, KEY_READ.0)
        .and_then(|k| k.dword(w!("AccentColor")))
        .map(hex_from_abgr);

    SystemAppearance { color_scheme, accent }
}

/// One thread per key, because `RegNotifyChangeKeyValue` watches a single key
/// and the two live under different parents. Both re-read the pair and compare
/// against the same last-seen value, so whichever fires does the same work the
/// portal watcher does on Linux.
pub(super) fn watch(app: tauri::AppHandle) {
    let last = Arc::new(Mutex::new(read()));
    // Which key, rather than the key itself: `PCWSTR` is a raw pointer and so
    // is not `Send`, even though these two point at string literals.
    for theme_key in [true, false] {
        let app = app.clone();
        let last = Arc::clone(&last);
        std::thread::spawn(move || watch_one(theme_key, app, last));
    }
}

fn watch_one(theme_key: bool, app: tauri::AppHandle, last: Arc<Mutex<SystemAppearance>>) {
    use tauri::Emitter;

    let subkey = if theme_key { PERSONALIZE } else { DWM };
    let Some(key) = Key::open(subkey, KEY_NOTIFY.0 | KEY_READ.0) else { return };
    loop {
        // Synchronous: the call returns when the key changes, which is what
        // this thread exists to wait for.
        let status = unsafe {
            RegNotifyChangeKeyValue(key.0, false, REG_NOTIFY_CHANGE_LAST_SET, None, false)
        };
        if status != ERROR_SUCCESS {
            return;
        }

        let now = read();
        let mut last = last.lock().unwrap_or_else(|e| e.into_inner());
        if now != *last {
            let _ = app.emit(super::CHANGED_EVENT, now.clone());
            *last = now;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The frontend switches on these exact strings. Absent is light, which is
    /// a real answer here rather than an absence of one.
    #[test]
    fn the_app_theme_value_maps_the_way_the_frontend_reads_it() {
        assert_eq!(scheme_name(Some(0)), "dark");
        assert_eq!(scheme_name(Some(1)), "light");
        assert_eq!(scheme_name(None), "light");
    }

    /// ABGR, not RGB. Reading it the obvious way swaps red and blue, which
    /// looks plausible enough on a grey accent to ship unnoticed.
    #[test]
    fn an_accent_dword_is_read_blue_first() {
        // Windows 11's default blue, #0078d4, stored as 0xffd47800.
        assert_eq!(hex_from_abgr(0xffd4_7800), "#0078d4");
        assert_eq!(hex_from_abgr(0xff00_0000), "#000000");
        assert_eq!(hex_from_abgr(0xffff_ffff), "#ffffff");
        // Alpha is ignored rather than folded in.
        assert_eq!(hex_from_abgr(0x00d4_7800), "#0078d4");
    }
}
