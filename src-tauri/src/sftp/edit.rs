//! Opening a file in whatever the desktop would open it with, and for a
//! remote file, sending every save back.
//!
//! A remote file comes down to a directory of its own under the system temp
//! dir, keeping its name so the application sees the real extension. From
//! then on a task watches the copy: when its size or mtime changes and then
//! holds still for one more tick, that is a save, and the file goes back up
//! to where it came from. The task ends, and takes its directory with it,
//! once the session it uploads through is gone.
//!
//! No inotify: a one second poll is enough for a person saving in an
//! editor, works the same on every platform, and needs no extra crate.

use super::*;
use super::listing::parent_remote;
use super::session::get_session;
use super::transfer::{download_path, upload_quiet, Conflict, Silent};
use std::path::Path;
use std::time::{Duration, SystemTime};

use anyhow::{anyhow, Context, Result};
use serde::Serialize;
use tauri::Emitter;

/// What the watcher tells the panel after each upload it attempts.
#[derive(Serialize, Clone, Debug)]
pub struct EditEvent {
    pub remote_path: String,
    pub name: String,
    pub error: Option<String>,
}

/// Between polls of the temp copy.
const TICK: Duration = Duration::from_secs(1);

/// How many polls the copy may be missing before the watcher gives up on
/// it. An editor that saves by renaming a new file over the old one leaves
/// the path empty for a moment; a user who deleted the copy leaves it empty
/// for good.
const MISSING_TICKS: u32 = 5;

pub fn open_local(path: &str) -> Result<()> {
    tauri_plugin_opener::open_path(path, None::<&str>).with_context(|| path.to_string())
}

/// `app` is for the events the watcher sends; the download itself reports
/// no progress, since nothing in the panel is waiting on it and a bar that
/// nothing ends would sit there after the file was long open.
pub async fn open_remote(
    app: &tauri::AppHandle,
    sftp_state: Arc<SftpClientState>,
    session_id: String,
    remote_path: String,
) -> Result<()> {
    let name = remote_path
        .rsplit('/')
        .next()
        .filter(|n| !n.is_empty())
        .ok_or_else(|| anyhow!("Not a file: {remote_path}"))?
        .to_string();
    let remote_dir = parent_remote(&remote_path);

    let dir = std::env::temp_dir()
        .join("bifrossh-edit")
        .join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&dir).with_context(|| dir.display().to_string())?;

    let summary = download_path(&Silent, &sftp_state, "edit", &session_id, &remote_path, &dir.to_string_lossy(), Conflict::Overwrite).await?;
    if summary.cancelled {
        let _ = std::fs::remove_dir_all(&dir);
        return Ok(());
    }
    let local = dir.join(&name);
    tauri_plugin_opener::open_path(&local, None::<&str>).with_context(|| local.display().to_string())?;

    let app = app.clone();
    let event = format!("sftp-edit:{session_id}");
    tokio::spawn(async move {
        watch(
            |e| { let _ = app.emit(&event, e); },
            &sftp_state,
            &session_id,
            &remote_dir,
            &remote_path,
            &local,
            TICK,
        )
        .await;
        let _ = std::fs::remove_dir_all(&dir);
    });
    Ok(())
}

type Stamp = (SystemTime, u64);

fn stamp(path: &Path) -> Option<Stamp> {
    let meta = std::fs::metadata(path).ok()?;
    Some((meta.modified().ok()?, meta.len()))
}

/// Polls `local` until the session is gone or the file stays gone, and
/// uploads it after each save. Public to the module so a test can drive it
/// with a short tick and its own `notify`.
pub(super) async fn watch(
    notify: impl Fn(EditEvent),
    sftp_state: &SftpClientState,
    session_id: &str,
    remote_dir: &str,
    remote_path: &str,
    local: &Path,
    tick: Duration,
) {
    let name = local.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let Some(mut last) = stamp(local) else { return };
    let mut pending: Option<Stamp> = None;
    let mut missing = 0u32;

    loop {
        tokio::time::sleep(tick).await;
        if get_session(sftp_state, session_id).await.is_err() {
            return;
        }
        let Some(now) = stamp(local) else {
            missing += 1;
            if missing >= MISSING_TICKS { return; }
            continue;
        };
        missing = 0;

        if now == last {
            pending = None;
            continue;
        }
        // A change is a save once it has held still for a whole tick: an
        // editor part way through writing has a size that is still moving.
        if pending != Some(now) {
            pending = Some(now);
            continue;
        }

        let error = upload_quiet(sftp_state, session_id, &local.to_string_lossy(), remote_dir)
            .await
            .err()
            .map(|e| format!("{e:#}"));
        notify(EditEvent { remote_path: remote_path.to_string(), name: name.clone(), error });
        last = now;
        pending = None;
    }
}
