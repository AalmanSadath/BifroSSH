//! SFTP: sessions, listings, transfers and file operations.
//!
//! Split four ways after the transfer engine was collapsed onto `FileSide`
//! and left the rest of an 859 line file around it. What sits here is the
//! vocabulary the other three share: the payload types that cross to the
//! webview, the session registry, and the two functions that decide whether a
//! name a server sent may be joined onto a path.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tokio::sync::Mutex;
use russh_sftp::client::SftpSession;

mod edit;
mod listing;
mod archive;
mod ops;
mod owners;
mod session;
mod transfer;
mod verify;
#[cfg(all(test, unix))]
mod sshd_tests;

pub use archive::{copy_archive, download_archive, upload_archive};
pub use edit::{open_local, open_remote};
pub use listing::{get_local_home, get_remote_home, list_local, list_remote};
pub use ops::{
    create_local_dir, delete_local, delete_remote, mkdir, rename_local, rename_remote,
    set_mode_local, set_mode_remote, set_owner_local, set_owner_remote,
};
pub use session::{connect_sftp, disconnect_sftp, probe_remote};
pub use verify::{comparable, compare_trees, verify_landing, Side, TreeDiff};
pub use transfer::{conflicts_for, copy_remote_path, download_path, upload_path, Conflict, Pairing, Tagged};

/// Chunk size for a streamed copy.
const CHUNK: usize = 128 * 1024; // 128 KB

#[derive(Serialize, Clone)]
pub struct TransferProgress {
    /// The id the panel gave the transfer, so a row in its queue can be
    /// told from the others. Stamped by the `Progress` sink.
    pub transfer_id: String,
    pub file_name: String,
    pub transferred: u64,
    pub total: u64,
    /// 1-based position of this file within the batch. Always 1/1 for a single
    /// file, so the UI can show "3 of 12" only when it means something.
    pub file_index: u32,
    pub file_count: u32,
}

/// Outcome of a recursive transfer, so the caller can report what was skipped
/// rather than silently copying less than the user asked for.
#[derive(Serialize, Clone, Default)]
pub struct TransferSummary {
    pub files: u32,
    pub directories: u32,
    /// Symlinks are not copied. Following them risks a loop that would recurse
    /// until the disk fills, and recreating them is not something SFTP does
    /// portably.
    pub skipped_symlinks: u32,
    /// Files left alone because one was already there and the policy was
    /// to skip.
    pub skipped_existing: u32,
    /// Files written beside an existing copy under a keep-both policy, and so
    /// under a name of their own.
    pub renamed: u32,
    /// True when the user stopped it. The files already copied are left where
    /// they are; only the one in flight is removed. `files` counts what
    /// actually arrived, so a cancelled batch reports fewer than were asked for.
    pub cancelled: bool,
    /// Where the transfer actually wrote, destination directory and name
    /// together. None when nothing was written.
    pub landed: Option<String>,
    /// Files whose checksum was compared with the source and matched; 0 when
    /// verification was off or was not possible. See `sftp::verify`.
    pub verified: u32,
}

/// Whether a file ran to the end or was stopped part way.
#[derive(PartialEq)]
enum Step {
    Finished,
    Cancelled,
}

/// One entry in a directory walk, relative to the transfer root.
struct TreeItem {
    rel: String,
    is_dir: bool,
    /// The file's size; 0 for a directory. Free from the walk, which reads
    /// each entry's attributes anyway, and what lets a comparison settle two
    /// files of different size without reading either.
    size: u64,
}

/// Guards against a pathological or hostile tree. Deeper than any real layout.
const MAX_DEPTH: usize = 64;

pub(super) fn join_remote(dir: &str, name: &str) -> String {
    if dir == "/" {
        format!("/{}", name)
    } else {
        format!("{}/{}", dir.trim_end_matches('/'), name)
    }
}

/// Whether a name a server gave us may be joined onto a path.
///
/// `join_remote` concatenates, and nothing downstream normalises the result, so
/// a name carrying a separator or `..` would place the file somewhere the user
/// did not choose. A recursive download builds its local destination the same
/// way, which makes this the boundary between a path the app decided on and one
/// a server did. Names come from the wire, not from a filesystem, so a server
/// is free to answer `read_dir` with whatever it likes.
fn is_safe_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains('\0')
}

#[derive(Serialize, Clone, Debug)]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: Option<u64>,
    pub permissions: String,
    /// The permission bits alone (`& 0o7777`), for a dialog to edit.
    ///
    /// `None` on a Windows local listing, where there is no POSIX mode to
    /// show, and for `..`, which is not a file the user can chmod.
    pub mode: Option<u32>,
    /// Numeric owner and group, `None` where the listing has none to give:
    /// a Windows local listing, `..`, or a server that sent no ids.
    pub uid: Option<u32>,
    pub gid: Option<u32>,
    /// `user:group` for display, names where known and numbers where not.
    /// Empty when the ids are.
    pub owner: String,
    pub kind: String,
    /// Kept out of the listing unless the panel is asked for hidden files.
    ///
    /// Decided here rather than in the frontend, because "hidden" is not one
    /// question. A leading dot is a naming convention; on Windows it is a file
    /// attribute, and the two do not overlap.
    pub hidden: bool,
    /// A symbolic link, whose target is what every other field describes.
    ///
    /// Worth saying, because once the link is followed it is otherwise
    /// indistinguishable from the thing it points at, and a link is not a
    /// safe thing to delete or copy without knowing it is one.
    pub symlink: bool,
}

/// One SFTP session and the connection under it.
///
/// The SSH handle used to be dropped once the subsystem channel was up,
/// which left nothing able to open a second channel. A compressed
/// download needs one, to run `tar` beside the SFTP session rather than
/// over a second connection with a second authentication.
pub(super) struct SftpConnection {
    pub(super) sftp: Arc<Mutex<SftpSession>>,
    pub(super) opener: Arc<dyn ChannelOpener>,
}

/// A live SSH connection, asked only for another channel.
///
/// Type-erased over the handler: the app connects with the host-key
/// verifier and the tests with one that trusts anything, and neither
/// difference matters to `tar`.
#[async_trait::async_trait]
pub(super) trait ChannelOpener: Send + Sync {
    async fn open_session(&self) -> anyhow::Result<russh::Channel<russh::client::Msg>>;
}

#[async_trait::async_trait]
impl<H: russh::client::Handler> ChannelOpener for russh::client::Handle<H> {
    async fn open_session(&self) -> anyhow::Result<russh::Channel<russh::client::Msg>> {
        self.channel_open_session().await.map_err(|e| anyhow::anyhow!("{e}"))
    }
}

pub struct SftpClientState {
    sessions: Mutex<HashMap<String, SftpConnection>>,
    /// One cancel flag per transfer in flight, by the id the panel gave
    /// it. The panel queues transfers and runs them one at a time, but
    /// each is cancelled by name, so a cancel pressed on one cannot land
    /// on the next. A std mutex: held for a map lookup, never across an
    /// await.
    transfers: std::sync::Mutex<HashMap<String, Arc<AtomicBool>>>,
    /// Each server's user and group names, read on first use and dropped
    /// with the session. See `owners`.
    names: Mutex<HashMap<String, Arc<owners::IdNames>>>,
}

/// A transfer's place in the table, given back when the transfer ends.
pub(super) struct TransferGuard<'a> {
    state: &'a SftpClientState,
    id: String,
    pub(super) cancel: Arc<AtomicBool>,
}

impl Drop for TransferGuard<'_> {
    fn drop(&mut self) {
        self.state.transfers.lock().unwrap().remove(&self.id);
    }
}

impl SftpClientState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            transfers: std::sync::Mutex::new(HashMap::new()),
            names: Mutex::new(HashMap::new()),
        }
    }

    /// Asks one transfer to stop at its next chunk boundary. An id that is
    /// not running, because it finished or never started, is nothing to do.
    pub fn request_cancel(&self, transfer_id: &str) {
        if let Some(flag) = self.transfers.lock().unwrap().get(transfer_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }

    /// A fresh flag for a transfer about to start, in the table until the
    /// guard drops.
    fn begin_transfer(&self, transfer_id: &str) -> TransferGuard<'_> {
        let cancel = Arc::new(AtomicBool::new(false));
        self.transfers.lock().unwrap().insert(transfer_id.to_string(), Arc::clone(&cancel));
        TransferGuard { state: self, id: transfer_id.to_string(), cancel }
    }

    /// Whether a transfer with this id is in the table. For the sshd tests,
    /// which are Unix only.
    #[cfg(all(test, unix))]
    fn is_running(&self, transfer_id: &str) -> bool {
        self.transfers.lock().unwrap().contains_key(transfer_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remote_paths_join_without_doubling_slashes() {
        assert_eq!(join_remote("/", "f.txt"), "/f.txt");
        assert_eq!(join_remote("/home/x", "f.txt"), "/home/x/f.txt");
        assert_eq!(join_remote("/home/x/", "f.txt"), "/home/x/f.txt");
        assert_eq!(join_remote("/home/x", "a/b.txt"), "/home/x/a/b.txt");
    }

    /// `join_remote` concatenating is the whole reason this guard exists: the
    /// test above asserts a name carrying a separator lands in a subdirectory,
    /// so a name a server chose must never reach it.
    #[test]
    fn a_name_from_a_server_cannot_leave_the_directory() {
        for name in ["..", ".", "", "../etc/passwd", "a/b", "a\\b", "a\0b"] {
            assert!(!is_safe_name(name), "{name:?} should have been refused");
        }
        for name in ["f.txt", "..hidden", "a..b", "...", " ", "naïve.txt"] {
            assert!(is_safe_name(name), "{name:?} is a legitimate filename");
        }
    }

    /// What the refusal buys, spelled out against the path that gets built.
    #[test]
    fn a_refused_name_is_what_stops_the_write_escaping() {
        let dest_root = "/home/user/Downloads";
        let hostile = "../../.ssh/authorized_keys";

        assert_eq!(
            join_remote(dest_root, hostile),
            "/home/user/Downloads/../../.ssh/authorized_keys",
            "nothing downstream normalises this, so the guard is the only defence",
        );
        assert!(!is_safe_name(hostile));
    }
}
