//! GTK's clipboard, read on the main thread.
//!
//! Every GTK call here has to happen on the thread that owns the main loop,
//! which is not the thread a Tauri command runs on, so the work goes over to
//! it and the answer comes back down a channel.

use std::sync::mpsc;
use std::time::Duration;

use tauri::AppHandle;

/// Long enough that a busy main loop still answers, short enough that a paste
/// that is never coming does not hold the command open.
const WAIT: Duration = Duration::from_secs(3);

pub(super) fn read_text(app: &AppHandle) -> Result<String, String> {
    let (tx, rx) = mpsc::channel();

    app.run_on_main_thread(move || {
        // wait_for_text runs a nested main loop until the owning application
        // hands the text over. That is re-entrant by design — it is how GTK
        // has always done a synchronous clipboard read — and this callback is
        // already on the main loop, which is where it has to be.
        let text = gtk::gdk::Display::default()
            .and_then(|display| gtk::Clipboard::default(&display))
            .and_then(|clipboard| clipboard.wait_for_text())
            .map(|text| text.to_string())
            .unwrap_or_default();
        // The receiver is gone only if the command timed out first, which is
        // not worth reporting to a main loop that can do nothing about it.
        let _ = tx.send(text);
    })
    .map_err(|e| format!("Could not reach the main thread: {e}"))?;

    rx.recv_timeout(WAIT)
        .map_err(|_| "The clipboard did not answer".to_string())
}
