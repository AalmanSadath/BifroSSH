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

mod listing;
mod ops;
mod session;
mod transfer;

pub use listing::{get_local_home, get_remote_home, list_local, list_remote};
pub use ops::{
    create_local_dir, delete_local, delete_remote, mkdir, rename_local, rename_remote,
};
pub use session::{connect_sftp, disconnect_sftp};
pub use transfer::{copy_remote_path, download_path, upload_path};

/// Chunk size for a streamed copy.
const CHUNK: usize = 128 * 1024; // 128 KB

#[derive(Serialize, Clone)]
pub struct TransferProgress {
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
    /// True when the user stopped it. The files already copied are left where
    /// they are; only the one in flight is removed. `files` counts what
    /// actually arrived, so a cancelled batch reports fewer than were asked for.
    pub cancelled: bool,
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
}

/// Guards against a pathological or hostile tree. Deeper than any real layout.
const MAX_DEPTH: usize = 64;

fn join_remote(dir: &str, name: &str) -> String {
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
    pub kind: String,
}

pub struct SftpClientState {
    sessions: Mutex<HashMap<String, Arc<Mutex<SftpSession>>>>,
    /// Raised to stop the transfer in flight.
    ///
    /// One flag rather than one per transfer because the panel runs a single
    /// transfer at a time: the drop targets are suppressed while one is
    /// running, so there is never a second to tell apart from the first.
    cancel: Arc<AtomicBool>,
}

impl SftpClientState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            cancel: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Asks the transfer in flight to stop at the next chunk boundary.
    pub fn request_cancel(&self) {
        self.cancel.store(true, Ordering::Relaxed);
    }

    /// Clears any cancellation left over from a previous transfer and hands
    /// back the flag to watch. Called once at the top of each transfer, so a
    /// cancel that arrived after the last one finished cannot kill the next.
    fn begin_transfer(&self) -> Arc<AtomicBool> {
        self.cancel.store(false, Ordering::Relaxed);
        Arc::clone(&self.cancel)
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
