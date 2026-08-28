//! Copying files between a local disk and a remote one, in any pairing.

use super::*;
use super::listing::{collect_local_tree, collect_remote_tree};
use super::session::get_session;
use std::fs;
use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use russh_sftp::client::SftpSession;
use tauri::Emitter;
use tokio::sync::Mutex;

/// How long one chunk may sit with nothing happening before the transfer is
/// called dead.
///
/// A server that goes away without closing the socket does not fail the
/// transfer: the SSH channel simply stops answering, and the await never
/// completes and never errors. Generous enough that no real link trips it —
/// a 128 KB chunk needs a link slower than 2 KB/s to take this long — and
/// short enough that a host that has gone is reported within the minute
/// rather than never.
const STALL: Duration = Duration::from_secs(60);

/// How often a waiting chunk looks up to check the clock and the cancel flag.
const TICK: Duration = Duration::from_secs(1);

/// Summary for the single file case, where there is no batch to report on.
fn single_file_summary(step: Step) -> TransferSummary {
    TransferSummary {
        files: if step == Step::Finished { 1 } else { 0 },
        cancelled: step == Step::Cancelled,
        ..Default::default()
    }
}

/// One end of a transfer: the local filesystem, or a remote SFTP session.
///
/// The three transfers the panel offers are the three pairings of these two:
/// upload is local to remote, download is remote to local, and a copy between
/// panes is remote to remote. Each used to be written out in full, so the
/// chunked copy loop, the tree walk and the batch bookkeeping existed three
/// times each and had to be kept in step by hand.
///
/// Paths are `&str` on both sides, but the two sides do not join them the same
/// way: a remote path is POSIX whatever this machine is, and a local path uses
/// this machine's own separator. Hence `join` on the trait rather than one
/// free function, which is what let `C:\\dst` and a relative `sub/file` end up
/// concatenated with the wrong slash.
#[async_trait]
trait FileSide {
    type Reader: tokio::io::AsyncRead + Unpin + Send;
    type Writer: tokio::io::AsyncWrite + Unpin + Send;

    async fn is_dir(&self, path: &str) -> Result<bool>;

    /// Every file and directory under `root`, plus a count of the symlinks
    /// passed over. Parents come before their children.
    async fn walk(&self, root: &str) -> Result<(Vec<TreeItem>, u32)>;

    /// Creates a directory, treating "already there" as success. Callers make
    /// every directory before any file, so this runs on paths that may already
    /// exist from an earlier transfer.
    async fn ensure_dir(&self, path: &str) -> Result<()>;

    /// A reader over `path`, and its size for the progress bar.
    async fn open_read(&self, path: &str) -> Result<(Self::Reader, u64)>;

    async fn create_write(&self, path: &str) -> Result<Self::Writer>;

    /// Best effort: this only ever runs on a file this process just made and
    /// then abandoned, and there is nothing useful to say if it will not go.
    async fn remove_file(&self, path: &str);

    /// `dir` and a path relative to it, joined the way this side spells paths.
    ///
    /// `rel` always arrives POSIX-separated: both tree walks record it that
    /// way, so it is one shape whichever side produced it, and only the local
    /// implementation has any translating to do.
    fn join(&self, dir: &str, rel: &str) -> String;
}

struct Local;

/// A POSIX-separated relative path in this machine's own spelling. Both tree
/// walks record `rel` with forward slashes, whichever side produced it.
#[cfg(windows)]
fn native(rel: &str) -> String {
    rel.replace('/', "\\")
}

#[cfg(not(windows))]
fn native(rel: &str) -> &str {
    rel
}

#[async_trait]
impl FileSide for Local {
    type Reader = tokio::fs::File;
    type Writer = tokio::fs::File;

    async fn is_dir(&self, path: &str) -> Result<bool> {
        fs::metadata(path)
            .map(|m| m.is_dir())
            .with_context(|| path.to_string())
    }

    async fn walk(&self, root: &str) -> Result<(Vec<TreeItem>, u32)> {
        collect_local_tree(Path::new(root))
    }

    async fn ensure_dir(&self, path: &str) -> Result<()> {
        fs::create_dir_all(path).with_context(|| path.to_string())
    }

    async fn open_read(&self, path: &str) -> Result<(Self::Reader, u64)> {
        let size = tokio::fs::metadata(path).await.map(|m| m.len()).unwrap_or(0);
        let file = tokio::fs::File::open(path)
            .await
            .with_context(|| path.to_string())?;
        Ok((file, size))
    }

    async fn create_write(&self, path: &str) -> Result<Self::Writer> {
        tokio::fs::File::create(path)
            .await
            .with_context(|| path.to_string())
    }

    async fn remove_file(&self, path: &str) {
        let _ = tokio::fs::remove_file(path).await;
    }

    /// `Path::join` rather than string concatenation, because it is the one
    /// that knows a Windows drive root ends in its own separator already and
    /// that `C:` alone is not a directory.
    fn join(&self, dir: &str, rel: &str) -> String {
        Path::new(dir).join(native(rel)).to_string_lossy().into_owned()
    }
}

struct Remote(Arc<Mutex<SftpSession>>);

/// Each method takes the session lock and gives it back before returning. The
/// handles outlive the guard, so a transfer holds no lock while it is copying,
/// which is what lets a copy run between two panes on one session.
#[async_trait]
impl FileSide for Remote {
    type Reader = russh_sftp::client::fs::File;
    type Writer = russh_sftp::client::fs::File;

    async fn is_dir(&self, path: &str) -> Result<bool> {
        let sftp = self.0.lock().await;
        let meta = sftp
            .metadata(path)
            .await
            .with_context(|| path.to_string())?;
        Ok(meta.file_type().is_dir())
    }

    async fn walk(&self, root: &str) -> Result<(Vec<TreeItem>, u32)> {
        collect_remote_tree(&self.0, root).await
    }

    async fn ensure_dir(&self, path: &str) -> Result<()> {
        let sftp = self.0.lock().await;
        // Unlike `create_dir_all`, SFTP's mkdir fails on a directory that is
        // already there, and that is the common case here.
        let _ = sftp.create_dir(path).await;
        Ok(())
    }

    async fn open_read(&self, path: &str) -> Result<(Self::Reader, u64)> {
        let sftp = self.0.lock().await;
        let meta = sftp
            .metadata(path)
            .await
            .with_context(|| path.to_string())?;
        let file = sftp
            .open(path)
            .await
            .with_context(|| path.to_string())?;
        Ok((file, meta.size.unwrap_or(0)))
    }

    async fn create_write(&self, path: &str) -> Result<Self::Writer> {
        let sftp = self.0.lock().await;
        sftp.create(path)
            .await
            .with_context(|| path.to_string())
    }

    fn join(&self, dir: &str, rel: &str) -> String {
        join_remote(dir, rel)
    }

    async fn remove_file(&self, path: &str) {
        let sftp = self.0.lock().await;
        let _ = sftp.remove_file(path).await;
    }
}

/// Where one file sits in its batch, for the progress the UI shows.
#[derive(Clone, Copy)]
struct Position {
    index: u32,
    count: u32,
}

/// What came of waiting on one read or write.
#[derive(Debug)]
enum Waited<T> {
    Done(T),
    Cancelled,
}

/// Runs one I/O step, while still watching the clock and the cancel flag.
///
/// Every await in the copy loop used to be unbounded, which is only safe
/// against a peer that fails loudly. A host that reboots mid-transfer does
/// not: the socket stays open with nothing on the other end, the channel
/// stops answering, and `read` or `write_all` parks on a future that will
/// never complete. The loop then never comes back round to its `cancel`
/// check, so Cancel does nothing, and the command never returns, so the panel
/// goes on showing a progress bar for a transfer that ended minutes ago.
///
/// The future is pinned once and polled across ticks rather than rebuilt each
/// time, so a chunk half written is not written again from the start.
async fn waited<T, F>(op: F, cancel: &AtomicBool, what: &str) -> Result<Waited<T>>
where
    F: Future<Output = std::io::Result<T>>,
{
    tokio::pin!(op);
    let deadline = tokio::time::Instant::now() + STALL;
    loop {
        tokio::select! {
            done = &mut op => return Ok(Waited::Done(done?)),
            _ = tokio::time::sleep(TICK) => {
                if cancel.load(Ordering::Relaxed) {
                    return Ok(Waited::Cancelled);
                }
                if tokio::time::Instant::now() >= deadline {
                    return Err(anyhow!(
                        "Transfer stalled: nothing {} for {} seconds. \
                         The connection is gone even though it was never closed.",
                        what,
                        STALL.as_secs()
                    ));
                }
            }
        }
    }
}

/// Streams one file across, in chunks, reporting as it goes.
///
/// Chunked rather than read whole into memory, so a large file does not have to
/// fit in RAM.
async fn transfer_one<S: FileSide, D: FileSide>(
    app: &tauri::AppHandle,
    src: &S,
    src_path: &str,
    dst: &D,
    dst_path: &str,
    at: Position,
    cancel: &AtomicBool,
) -> Result<Step> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let file_name = Path::new(dst_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();

    let (mut reader, total) = src.open_read(src_path).await?;
    let mut writer = dst.create_write(dst_path).await?;

    let outcome = async {
        let mut buf = vec![0u8; CHUNK];
        let mut transferred = 0u64;
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Ok(Step::Cancelled);
            }
            let n = match waited(reader.read(&mut buf), cancel, "read").await? {
                Waited::Done(n) => n,
                Waited::Cancelled => return Ok(Step::Cancelled),
            };
            if n == 0 {
                break;
            }
            match waited(writer.write_all(&buf[..n]), cancel, "written").await? {
                Waited::Done(()) => {}
                Waited::Cancelled => return Ok(Step::Cancelled),
            }
            transferred += n as u64;
            let _ = app.emit(
                "sftp-progress",
                TransferProgress {
                    file_name: file_name.clone(),
                    transferred,
                    total,
                    file_index: at.index,
                    file_count: at.count,
                },
            );
        }

        // A stream that ends early is not a shorter file, it is an incomplete
        // one. `total` had only ever been used to fill the progress event, so
        // a connection that died mid-file reached this break on EOF and was
        // reported as a transfer that finished.
        if transferred < total {
            return Err(anyhow!(
                "{} ended after {} of {} bytes",
                file_name,
                transferred,
                total
            ));
        }

        match waited(writer.flush(), cancel, "flushed").await? {
            Waited::Done(()) => Ok(Step::Finished),
            Waited::Cancelled => Ok(Step::Cancelled),
        }
    }
    .await;

    // A part written file is not a shorter file, it is a corrupt one, and
    // nothing here can resume it. Removing it is the honest outcome; leaving
    // it puts something that looks complete beside the files that are. This
    // now covers a failure as well as a cancel: before, an error left the
    // stub behind.
    if !matches!(outcome, Ok(Step::Finished)) {
        drop(writer);
        dst.remove_file(dst_path).await;
    }
    outcome
}

/// Copies `src_path` into `dst_dir`, recursing if it names a directory.
///
/// The destination keeps the source's own name, so this is "drop it in here"
/// rather than "write it as this".
async fn transfer<S: FileSide, D: FileSide>(
    app: &tauri::AppHandle,
    src: &S,
    src_path: &str,
    dst: &D,
    dst_dir: &str,
    cancel: &AtomicBool,
) -> Result<TransferSummary> {
    let name = Path::new(src_path)
        .file_name()
        .context("Invalid source path")?
        .to_string_lossy()
        .into_owned();
    // Refused rather than joined: an empty directory would join to a bare
    // relative name and write wherever the process happens to be.
    if dst_dir.is_empty() {
        return Err(anyhow!("No destination directory"));
    }
    let dest_root = dst.join(dst_dir, &name);

    if !src.is_dir(src_path).await? {
        let at = Position { index: 1, count: 1 };
        let step = transfer_one(app, src, src_path, dst, &dest_root, at, cancel).await?;
        return Ok(single_file_summary(step));
    }

    let (items, skipped_symlinks) = src.walk(src_path).await?;
    let files: Vec<&TreeItem> = items.iter().filter(|i| !i.is_dir).collect();
    let count = files.len() as u32;

    // Every directory first, so no file lands before its parent exists. The
    // walk returns parents before children, which is what makes one pass enough.
    dst.ensure_dir(&dest_root).await?;
    let mut directories = 0u32;
    for item in items.iter().filter(|i| i.is_dir) {
        dst.ensure_dir(&dst.join(&dest_root, &item.rel)).await?;
        directories += 1;
    }

    for (i, item) in files.iter().enumerate() {
        let at = Position { index: i as u32 + 1, count };
        let step = transfer_one(
            app,
            src,
            &src.join(src_path, &item.rel),
            dst,
            &dst.join(&dest_root, &item.rel),
            at,
            cancel,
        )
        .await?;
        // Files already copied are left alone; only the one in flight is
        // removed. `files` therefore counts what actually arrived.
        if step == Step::Cancelled {
            return Ok(TransferSummary {
                files: i as u32,
                directories,
                skipped_symlinks,
                cancelled: true,
            });
        }
    }

    Ok(TransferSummary { files: count, directories, skipped_symlinks, cancelled: false })
}

/// Uploads a file, or a directory tree rooted at `local_path`.
pub async fn upload_path(
    app: &tauri::AppHandle,
    sftp_state: &SftpClientState,
    session_id: &str,
    local_path: &str,
    remote_dir: &str,
) -> Result<TransferSummary> {
    let remote = Remote(get_session(sftp_state, session_id).await?);
    let cancel = sftp_state.begin_transfer();
    transfer(app, &Local, local_path, &remote, remote_dir, &cancel).await
}

/// Downloads a file, or a directory tree rooted at `remote_path`.
pub async fn download_path(
    app: &tauri::AppHandle,
    sftp_state: &SftpClientState,
    session_id: &str,
    remote_path: &str,
    local_dir: &str,
) -> Result<TransferSummary> {
    let remote = Remote(get_session(sftp_state, session_id).await?);
    let cancel = sftp_state.begin_transfer();
    transfer(app, &remote, remote_path, &Local, local_dir, &cancel).await
}

/// Copies a file, or a directory tree, between two remote sessions.
pub async fn copy_remote_path(
    app: &tauri::AppHandle,
    sftp_state: &SftpClientState,
    src_session_id: &str,
    src_path: &str,
    dst_session_id: &str,
    dst_dir: &str,
) -> Result<TransferSummary> {
    let src = Remote(get_session(sftp_state, src_session_id).await?);
    let dst = Remote(get_session(sftp_state, dst_session_id).await?);
    let cancel = sftp_state.begin_transfer();
    transfer(app, &src, src_path, &dst, dst_dir, &cancel).await
}

#[cfg(test)]
mod tests {
    /// The two sides spell paths differently, and `rel` always arrives
    /// POSIX-separated. Downloading a folder onto Windows is the case that
    /// used to concatenate a backslash directory with a forward-slash
    /// relative path.
    #[test]
    fn each_side_joins_the_way_it_spells_paths() {
        use super::{FileSide, Local};
        let local = Local;

        // Remote is always POSIX, whatever this machine is. Constructing one
        // needs a live session, so the free function it delegates to stands in
        // for it; `Remote::join` is one line calling exactly this.
        assert_eq!(super::join_remote("/home/x", "a/b.txt"), "/home/x/a/b.txt");
        assert_eq!(super::join_remote("/", "f.txt"), "/f.txt");

        #[cfg(unix)]
        {
            assert_eq!(local.join("/home/x", "a/b.txt"), "/home/x/a/b.txt");
            assert_eq!(local.join("/home/x/", "f.txt"), "/home/x/f.txt");
            assert_eq!(local.join("/", "f.txt"), "/f.txt");
        }
        #[cfg(windows)]
        {
            assert_eq!(local.join("C:\\dst", "a/b.txt"), "C:\\dst\\a\\b.txt");
            // A drive root already ends in its own separator.
            assert_eq!(local.join("C:\\", "f.txt"), "C:\\f.txt");
            assert_eq!(local.join("C:\\dst\\", "f.txt"), "C:\\dst\\f.txt");
        }
    }

    use super::*;
    use std::io;

    /// A read or write that will never answer, which is what an SSH channel to
    /// a host that has gone looks like: no data, no error, no close.
    fn never() -> impl Future<Output = io::Result<usize>> {
        std::future::pending()
    }

    /// The clock is paused in these tests, so tokio advances it as soon as
    /// every task is idle. A sixty second stall therefore costs no wall time.
    #[tokio::test(start_paused = true)]
    async fn a_transfer_whose_peer_vanished_is_called_stalled_rather_than_awaited_forever() {
        let cancel = AtomicBool::new(false);
        let err = waited(never(), &cancel, "read")
            .await
            .expect_err("a peer that never answers must not be waited on forever");
        let message = format!("{err}");
        assert!(message.contains("stalled"), "{message}");
        assert!(message.contains("60 seconds"), "{message}");
    }

    /// The defect this covers is not that Cancel was unimplemented, but that
    /// it could not be reached: the flag was read at the top of the copy loop,
    /// and a parked await never came back round to it.
    #[tokio::test(start_paused = true)]
    async fn cancel_reaches_a_transfer_that_is_already_parked_on_a_dead_connection() {
        let cancel = AtomicBool::new(true);
        let waited = waited(never(), &cancel, "read")
            .await
            .expect("a cancelled wait is an outcome, not a failure");
        assert!(matches!(waited, Waited::Cancelled));
    }

    #[tokio::test(start_paused = true)]
    async fn a_chunk_that_arrives_is_handed_back_untouched() {
        let cancel = AtomicBool::new(false);
        let waited = waited(async { io::Result::Ok(4096usize) }, &cancel, "read")
            .await
            .unwrap();
        assert!(matches!(waited, Waited::Done(4096)));
    }

    /// A slow link is not a dead one. Anything that finishes inside the window
    /// has to come back as itself, or the fix for the wedge would break every
    /// transfer over a bad connection.
    #[tokio::test(start_paused = true)]
    async fn a_slow_chunk_is_not_mistaken_for_a_stalled_one() {
        let cancel = AtomicBool::new(false);
        let slow = async {
            tokio::time::sleep(STALL - Duration::from_secs(5)).await;
            io::Result::Ok(1usize)
        };
        let waited = waited(slow, &cancel, "read").await.unwrap();
        assert!(matches!(waited, Waited::Done(1)));
    }

    /// The error the caller reports is the one that names the failure, not an
    /// io::Error wrapped in a stall message.
    #[tokio::test(start_paused = true)]
    async fn a_connection_that_fails_loudly_keeps_its_own_error() {
        let cancel = AtomicBool::new(false);
        let broken = async { io::Result::<usize>::Err(io::Error::other("connection reset")) };
        let err = waited(broken, &cancel, "read").await.unwrap_err();
        assert!(format!("{err}").contains("connection reset"));
    }
}
