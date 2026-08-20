//! What the desktop says it looks like: light or dark, and its accent colour.
//!
//! Read through the XDG desktop portal rather than gsettings or the GTK
//! theme. The portal is the only source that answers from inside the Flatpak
//! sandbox, where dconf is not visible, and it is the same answer on the
//! desktops that are not GNOME.
//!
//! Both values are advisory. A desktop that does not implement the
//! `org.freedesktop.appearance` namespace is not an error: it means the app
//! falls back to its own dark theme and its own accent, which is what it did
//! before any of this existed.

use serde::Serialize;

/// The namespace every desktop that answers this agrees on.
const NAMESPACE: &str = "org.freedesktop.appearance";

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

#[cfg(unix)]
mod portal {
    use super::*;
    use zbus::blocking::{Connection, Proxy};
    use zbus::zvariant::OwnedValue;

    fn settings_proxy(conn: &Connection) -> zbus::Result<Proxy<'_>> {
        Proxy::new(
            conn,
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.Settings",
        )
    }

    fn read_one(proxy: &Proxy<'_>, key: &str) -> zbus::Result<OwnedValue> {
        proxy.call("ReadOne", &(NAMESPACE, key))
    }

    /// 0 is no preference, 1 is dark, 2 is light. Anything else is a desktop
    /// saying something this does not understand, which is not a preference
    /// either.
    pub(super) fn scheme_name(raw: u32) -> &'static str {
        match raw {
            1 => "dark",
            2 => "light",
            _ => "no-preference",
        }
    }

    /// The portal gives three doubles in 0..1, not bytes.
    pub(super) fn hex_from_rgb(r: f64, g: f64, b: f64) -> String {
        let byte = |v: f64| (v.clamp(0.0, 1.0) * 255.0).round() as u8;
        format!("#{:02x}{:02x}{:02x}", byte(r), byte(g), byte(b))
    }

    pub fn read() -> SystemAppearance {
        let Ok(conn) = Connection::session() else {
            return SystemAppearance::default();
        };
        let Ok(proxy) = settings_proxy(&conn) else {
            return SystemAppearance::default();
        };

        let color_scheme = read_one(&proxy, "color-scheme")
            .ok()
            .and_then(|v| u32::try_from(v).ok())
            .map(scheme_name)
            .unwrap_or("no-preference")
            .to_string();

        // Absent on every desktop older than GNOME 47, so a failure here is
        // the normal case rather than a fault worth reporting.
        let accent = read_one(&proxy, "accent-color")
            .ok()
            .and_then(|v| <(f64, f64, f64)>::try_from(v).ok())
            .map(|(r, g, b)| hex_from_rgb(r, g, b));

        SystemAppearance { color_scheme, accent }
    }
}

#[cfg(not(unix))]
mod portal {
    use super::SystemAppearance;

    pub fn read() -> SystemAppearance {
        SystemAppearance::default()
    }
}

/// Reads both values, blocking on the session bus.
///
/// Never fails: a desktop that cannot be asked is reported as having no
/// preference and no accent, which the frontend already has to handle.
pub fn read() -> SystemAppearance {
    portal::read()
}

/// Name of the event the frontend listens on for a desktop that changed its
/// mind. Payload is a [`SystemAppearance`].
pub const CHANGED_EVENT: &str = "system-appearance-changed";

/// Watches the portal and reports every change for as long as the app runs.
///
/// A thread rather than a task, and the blocking bus API, because this spends
/// its whole life parked on one signal and never touches anything async.
/// Failing to start is survivable: the theme still resolves on launch and
/// whenever settings are read, it just stops following the desktop live.
#[cfg(unix)]
pub fn watch(app: tauri::AppHandle) {
    use tauri::Emitter;
    use zbus::blocking::{Connection, Proxy};

    std::thread::spawn(move || {
        let Ok(conn) = Connection::session() else { return };
        let Ok(proxy) = Proxy::new(
            &conn,
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.Settings",
        ) else {
            return;
        };
        let Ok(signals) = proxy.receive_signal("SettingChanged") else { return };

        // Re-read both values rather than decoding the one that changed. The
        // signal carries a variant whose type depends on the key, and the
        // frontend wants the pair anyway.
        let mut last = read();
        for _ in signals {
            let now = read();
            if now != last {
                let _ = app.emit(CHANGED_EVENT, now.clone());
                last = now;
            }
        }
    });
}

#[cfg(not(unix))]
pub fn watch(_app: tauri::AppHandle) {}

#[cfg(test)]
mod tests {
    use super::*;

    /// The frontend switches on these exact strings, and 0 has to be distinct
    /// from light: a desktop with no preference gets the app's own default,
    /// not a guess at white.
    #[test]
    #[cfg(unix)]
    fn the_three_color_scheme_values_are_named_the_way_the_frontend_reads_them() {
        assert_eq!(portal::scheme_name(1), "dark");
        assert_eq!(portal::scheme_name(2), "light");
        assert_eq!(portal::scheme_name(0), "no-preference");
        assert_eq!(portal::scheme_name(99), "no-preference");
    }

    /// The portal answers in doubles. Rounding rather than truncating, or
    /// GNOME's purple comes back a shade off the colour the desktop drew.
    #[test]
    #[cfg(unix)]
    fn an_accent_in_doubles_becomes_the_hex_the_desktop_meant() {
        // GNOME 47's purple, as the portal reports it.
        assert_eq!(
            portal::hex_from_rgb(0.5686274766921997, 0.2549019753932953, 0.6745098233222961),
            "#9141ac"
        );
        assert_eq!(portal::hex_from_rgb(0.0, 0.0, 0.0), "#000000");
        assert_eq!(portal::hex_from_rgb(1.0, 1.0, 1.0), "#ffffff");
        // Out of range rather than panicking or wrapping.
        assert_eq!(portal::hex_from_rgb(-1.0, 2.0, 0.5), "#00ff80");
    }
}
