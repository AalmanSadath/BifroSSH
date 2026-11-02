//! logind's `PrepareForSleep`, and the graphical session's `LockedHint` and
//! `Lock`, on the system bus.
//!
//! `true` arrives before the machine sleeps and `false` after it wakes. The
//! first may lock the vault; the second is passed to `netwatch`, since the
//! connections may not have survived the sleep. A thread and the blocking bus API, as in
//! `appearance::unix`, because this spends its life parked on one signal.

use tauri::AppHandle;
use zbus::blocking::{Connection, Proxy};
use zbus::zvariant::OwnedObjectPath;

pub(super) fn watch(app: AppHandle) {
    watch_sleep(app.clone());
    watch_screen_lock(app);
}

fn watch_sleep(app: AppHandle) {
    std::thread::spawn(move || {
        // No system bus, or no logind: nothing to watch, and nothing to say.
        // A machine without either is not one that sleeps under us.
        let Ok(conn) = Connection::system() else { return };
        let Ok(proxy) = Proxy::new(
            &conn,
            "org.freedesktop.login1",
            "/org/freedesktop/login1",
            "org.freedesktop.login1.Manager",
        ) else {
            return;
        };
        let Ok(signals) = proxy.receive_signal("PrepareForSleep") else { return };

        for msg in signals {
            let Ok(starting) = msg.body().deserialize::<bool>() else { continue };
            if starting {
                super::on_suspend(&app);
            } else {
                crate::netwatch::notify(&app);
            }
        }
    });
}

/// The user's graphical session on logind: the one whose lock screen counts.
///
/// Found through the user rather than as `session/auto`, which names the
/// caller's own session: inside Flatpak the app runs in a scope of its own,
/// which logind does not count as part of any session.
fn display_session(conn: &Connection) -> Option<OwnedObjectPath> {
    let user = Proxy::new(
        conn,
        "org.freedesktop.login1",
        "/org/freedesktop/login1/user/self",
        "org.freedesktop.login1.User",
    )
    .ok()?;
    let (id, path): (String, OwnedObjectPath) = user.get_property("Display").ok()?;
    // No graphical session is an empty id and the root path.
    (!id.is_empty()).then_some(path)
}

fn session_proxy(conn: &Connection, path: OwnedObjectPath) -> Option<Proxy<'static>> {
    Proxy::new(conn, "org.freedesktop.login1", path, "org.freedesktop.login1.Session").ok()
}

/// Two signs of the screen locking, each on a thread of its own because each
/// is a blocking wait. `LockedHint` is what GNOME and KDE set when their lock
/// screen comes up, however it was asked for. `Lock` is logind asking the
/// desktop to lock (`loginctl lock-session`), which a desktop that does not
/// set the hint still answers.
fn watch_screen_lock(app: AppHandle) {
    let Ok(conn) = Connection::system() else { return };
    let Some(path) = display_session(&conn) else { return };

    let hint_app = app.clone();
    let hint_conn = conn.clone();
    let hint_path = path.clone();
    std::thread::spawn(move || {
        let Some(session) = session_proxy(&hint_conn, hint_path) else { return };
        let mut locked = session.get_property::<bool>("LockedHint").unwrap_or(false);
        for change in session.receive_property_changed::<bool>("LockedHint") {
            let Ok(now) = change.get() else { continue };
            // Acted on as it turns on only: the same value again is not a
            // new lock, and the vault stays as the user left it at unlock.
            if now && !locked {
                super::on_screen_lock(&hint_app);
            }
            locked = now;
        }
    });

    std::thread::spawn(move || {
        let Some(session) = session_proxy(&conn, path) else { return };
        let Ok(signals) = session.receive_signal("Lock") else { return };
        for _ in signals {
            super::on_screen_lock(&app);
        }
    });
}
