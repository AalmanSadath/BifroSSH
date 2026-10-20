// ── Detached tabs ──────────────────────────────────────────────

use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

use super::CmdResult;

/// What a detached tab's window label starts with. The rest is the tab id,
/// which is how the window knows which tab it is showing.
pub const DETACHED_PREFIX: &str = "term-";

/// What one window hands the next when a tab moves between them: the tab, its
/// screen and scrollback, and why it moved. Opaque here; the frontend writes
/// it and the frontend reads it. Each entry is taken by the window it was left
/// for, so the map only ever holds tabs that are mid-move.
#[derive(Default)]
pub struct DetachedTabs(Mutex<HashMap<String, String>>);

impl DetachedTabs {
    fn put(&self, tab_id: &str, payload: String) {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).insert(tab_id.to_string(), payload);
    }

    fn take(&self, tab_id: &str) -> Option<String> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(tab_id)
    }
}

/// The window label for a tab, refusing anything that is not a tab id. Tab ids
/// are UUIDs, and a label may only hold a few kinds of character, so anything
/// else would fail later and less clearly.
fn label_for(tab_id: &str) -> CmdResult<String> {
    let valid = !tab_id.is_empty()
        && tab_id.len() <= 64
        && tab_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if !valid {
        return Err("Not a tab id".into());
    }
    Ok(format!("{DETACHED_PREFIX}{tab_id}"))
}

/// Opens a window for one terminal tab, leaving `payload` for it to collect.
///
/// The window loads the same page as the main one; it sees from its label
/// that it is a tab's window and shows only that terminal. Built here rather
/// than from the page so the page needs no permission to create windows.
/// Async because creating a window from a synchronous command deadlocks on
/// Windows.
#[tauri::command]
pub async fn window_detach(
    app: AppHandle,
    detached: State<'_, DetachedTabs>,
    tab_id: String,
    title: String,
    payload: String,
) -> CmdResult<()> {
    if cfg!(mobile) {
        return Err("Tabs cannot move to a window of their own on this platform".into());
    }
    let label = label_for(&tab_id)?;
    if app.get_webview_window(&label).is_some() {
        return Err("This tab is already in a window of its own".into());
    }
    detached.put(&tab_id, payload);
    let built = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title(title)
        .inner_size(1000.0, 650.0)
        .min_inner_size(400.0, 250.0)
        // A terminal takes no dropped files, and on Windows the handler would
        // turn off the page's own drag and drop.
        .disable_drag_drop_handler()
        .build();
    if let Err(e) = built {
        detached.take(&tab_id);
        return Err(format!("Could not open a window for this tab: {e}").into());
    }
    Ok(())
}

/// What was left for a tab's window, once: the opening payload for a new
/// window, or what a closing one left for the main window. None when nothing
/// was, as after a window that crashed.
#[tauri::command]
pub fn window_take(detached: State<'_, DetachedTabs>, tab_id: String) -> Option<String> {
    detached.take(&tab_id)
}

/// Leaves `payload` for whoever takes this tab next. A closing tab window
/// calls this before it goes, and the main window takes it when told the
/// window has gone.
#[tauri::command]
pub fn window_stash(detached: State<'_, DetachedTabs>, tab_id: String, payload: String) {
    detached.put(&tab_id, payload);
}

/// Brings a tab's window to the front.
#[tauri::command]
pub fn window_focus(app: AppHandle, tab_id: String) -> CmdResult<()> {
    let label = label_for(&tab_id)?;
    let window = app.get_webview_window(&label).ok_or("That window has closed")?;
    #[cfg(desktop)]
    let _ = window.unminimize();
    let _ = window.show();
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

/// What happens when any window has gone.
///
/// A tab's window tells the main window, which takes the tab back with
/// whatever the window left for it. However that window went, closed by the
/// user, by its own session ending or by a crash, this is the one path back.
///
/// The main window going takes every tab window with it. They show sessions
/// the main window owns, and left open they would keep the app running with
/// no way back to the rest of it.
pub fn window_destroyed(app: &AppHandle, label: &str) {
    if let Some(tab_id) = label.strip_prefix(DETACHED_PREFIX) {
        let _ = app.emit_to("main", "detached-gone", tab_id);
    } else if label == "main" {
        for (other, window) in app.webview_windows() {
            if other.starts_with(DETACHED_PREFIX) {
                let _ = window.destroy();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tab_id_becomes_its_window_label() {
        let id = "3f2b6c1e-8d4a-4b8e-9c1d-2a7e5f0b9c3d";
        assert_eq!(label_for(id).unwrap(), format!("term-{id}"));
    }

    #[test]
    fn anything_else_is_refused() {
        for bad in ["", "../main", "a b", "main/x", "é", &"a".repeat(65)] {
            assert!(label_for(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn a_payload_is_taken_once() {
        let d = DetachedTabs::default();
        d.put("t", "first".into());
        d.put("t", "second".into());
        assert_eq!(d.take("t").as_deref(), Some("second"));
        assert_eq!(d.take("t"), None);
    }
}
