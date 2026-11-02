//! The network monitor portal's `changed` signal, on the session bus.
//!
//! A thread and the blocking bus API, as in `suspend::linux`, because this
//! spends its life parked on one signal.

use tauri::AppHandle;
use zbus::blocking::{Connection, Proxy};

pub(super) fn watch(app: AppHandle) {
    std::thread::spawn(move || {
        // No session bus or no portal: no notice of changes, and connections
        // on a dead network wait for keepalives as they always did.
        let Ok(conn) = Connection::session() else { return };
        let Ok(proxy) = Proxy::new(
            &conn,
            "org.freedesktop.portal.Desktop",
            "/org/freedesktop/portal/desktop",
            "org.freedesktop.portal.NetworkMonitor",
        ) else {
            return;
        };
        // Asked for something first so the bus starts the portal if it is not
        // running yet; a signal from a service nobody started never comes.
        let _ = proxy.get_property::<u32>("version");
        let Ok(signals) = proxy.receive_signal("changed") else { return };

        for _ in signals {
            super::notify(&app);
        }
    });
}
