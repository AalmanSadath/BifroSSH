//! logind's `PrepareForSleep`, on the system bus.
//!
//! `true` arrives before the machine sleeps and `false` after it wakes. Only
//! the first is acted on. A thread and the blocking bus API, as in
//! `appearance::unix`, because this spends its life parked on one signal.

use tauri::AppHandle;
use zbus::blocking::{Connection, Proxy};

pub(super) fn watch(app: AppHandle) {
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
            }
        }
    });
}
