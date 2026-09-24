//! Copying files between a local disk and a remote one, in any pairing.

use super::*;
use super::listing::{collect_local_tree, collect_remote_tree};
use super::session::{get_opener, get_session};
use std::fs;
use std::future::Future;
use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use russh_sftp::client::SftpSession;
use tauri::Emitter;
use tokio::sync::Mutex;

/// Where progress goes. The app sends it to the window as an event; a test
/// has no window and throws it away. This is the one thing a transfer needed
/// from Tauri, and it is what stopped any transfer running under `cargo test`.
pub trait Progress: Sync {
    fn report(&self, progress: TransferProgress);
}

/// The window, with the id of the transfer being reported on. The copy
/// loop does not know its id; this stamps it on the way out.
pub struct Tagged<'a> {
    pub app: &'a tauri::AppHandle,
    pub transfer_id: String,
}

impl Progress for Tagged<'_> {
    fn report(&self, mut progress: TransferProgress) {
        progress.transfer_id = self.transfer_id.clone();
        // Nothing to do if the window is gone; the transfer finishes anyway.
        let _ = self.app.emit("sftp-progress", progress);
    }
}

/// Progress with nowhere to go: tests, and transfers the panel is not
/// showing, which is what an edit-in-place upload behind the user's back is.
pub(super) struct Silent;
impl Progress for Silent {
    fn report(&self, _: TransferProgress) {}
}

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
pub(super) trait FileSide {
    // Seekable because a resume starts part way through both files.
    type Reader: tokio::io::AsyncRead + tokio::io::AsyncSeek + Unpin + Send;
    type Writer: tokio::io::AsyncWrite + tokio::io::AsyncSeek + Unpin + Send;

    async fn is_dir(&self, path: &str) -> Result<bool>;

    /// Whether anything is at `path`. A file the transfer is about to
    /// write over, which is the one question the conflict policy asks.
    async fn exists(&self, path: &str) -> bool;

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

    /// The size of `path`, or None if nothing is there. Asked about an
    /// unfinished file, which may well not exist.
    async fn size(&self, path: &str) -> Option<u64>;

    /// A writer over an existing file, positioned at `offset` and truncating
    /// nothing, so a resume adds to what is already there.
    async fn open_write_at(&self, path: &str, offset: u64) -> Result<Self::Writer>;

    /// The SHA-256 of the first `len` bytes of `path`, computed where the file
    /// lives. Nothing crosses the network for it, which is the whole point:
    /// reading the bytes back to check them would cost what resuming saves.
    async fn digest_prefix(&self, path: &str, len: u64) -> Result<String>;

    /// The SHA-256 of each of `paths`, whole, keyed by the path given. Also
    /// computed where the files live.
    async fn digests(&self, paths: &[String]) -> Result<HashMap<String, String>>;

    /// Moves `from` over `to`, replacing whatever `to` was.
    async fn rename(&self, from: &str, to: &str) -> Result<()>;

    /// Finishes with a reader. Best effort: nothing was written through it.
    async fn close_read(&self, reader: Self::Reader);

    /// Finishes with a writer. An error here is a file that may not be
    /// complete, which is why this one is not best effort.
    async fn close_write(&self, writer: Self::Writer) -> Result<()>;

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

pub(super) struct Local;

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

    async fn exists(&self, path: &str) -> bool {
        tokio::fs::metadata(path).await.is_ok()
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

    async fn rename(&self, from: &str, to: &str) -> Result<()> {
        tokio::fs::rename(from, to)
            .await
            .with_context(|| format!("renaming {from} to {to}"))
    }

    async fn size(&self, path: &str) -> Option<u64> {
        tokio::fs::metadata(path).await.ok().map(|m| m.len())
    }

    async fn open_write_at(&self, path: &str, offset: u64) -> Result<Self::Writer> {
        use tokio::io::AsyncSeekExt;
        let mut file = tokio::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .await
            .with_context(|| path.to_string())?;
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .with_context(|| path.to_string())?;
        Ok(file)
    }

    async fn digest_prefix(&self, path: &str, len: u64) -> Result<String> {
        let path = std::path::PathBuf::from(path);
        tokio::task::spawn_blocking(move || super::verify::digest_file(&path, Some(len)))
            .await
            .map_err(|e| anyhow!("The checksum stopped: {e}"))?
    }

    async fn digests(&self, paths: &[String]) -> Result<HashMap<String, String>> {
        let paths = paths.to_vec();
        tokio::task::spawn_blocking(move || {
            let mut out = HashMap::new();
            for path in paths {
                let digest = super::verify::digest_file(Path::new(&path), None)?;
                out.insert(path, digest);
            }
            Ok(out)
        })
        .await
        .map_err(|e| anyhow!("The checksum stopped: {e}"))?
    }

    // A local file is closed by dropping it; the OS does the bookkeeping.
    async fn close_read(&self, _reader: Self::Reader) {}

    async fn close_write(&self, _writer: Self::Writer) -> Result<()> {
        Ok(())
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

/// One side of a transfer on a server: the SFTP session it copies through,
/// and a way to open a shell channel, which is how a digest is asked for
/// without reading the file back across the network.
pub(super) struct Remote {
    pub(super) sftp: Arc<Mutex<SftpSession>>,
    pub(super) opener: Arc<dyn ChannelOpener>,
}

/// The remote side of `session_id`, both halves of it.
pub(super) async fn remote_side(
    sftp_state: &SftpClientState,
    session_id: &str,
) -> Result<Remote> {
    Ok(Remote {
        sftp: get_session(sftp_state, session_id).await?,
        opener: get_opener(sftp_state, session_id).await?,
    })
}

/// Each method takes the session lock and gives it back before returning. The
/// handles outlive the guard, so a transfer holds no lock while it is copying,
/// which is what lets a copy run between two panes on one session.
#[async_trait]
impl FileSide for Remote {
    type Reader = russh_sftp::client::fs::File;
    type Writer = russh_sftp::client::fs::File;

    async fn is_dir(&self, path: &str) -> Result<bool> {
        let sftp = self.sftp.lock().await;
        let meta = sftp
            .metadata(path)
            .await
            .with_context(|| path.to_string())?;
        Ok(meta.file_type().is_dir())
    }

    async fn exists(&self, path: &str) -> bool {
        let sftp = self.sftp.lock().await;
        sftp.metadata(path).await.is_ok()
    }

    async fn walk(&self, root: &str) -> Result<(Vec<TreeItem>, u32)> {
        collect_remote_tree(&self.sftp, root).await
    }

    async fn ensure_dir(&self, path: &str) -> Result<()> {
        let sftp = self.sftp.lock().await;
        // Unlike `create_dir_all`, SFTP's mkdir fails on a directory that is
        // already there, and that is the common case here.
        let _ = sftp.create_dir(path).await;
        Ok(())
    }

    async fn open_read(&self, path: &str) -> Result<(Self::Reader, u64)> {
        let sftp = self.sftp.lock().await;
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
        let sftp = self.sftp.lock().await;
        sftp.create(path)
            .await
            .with_context(|| path.to_string())
    }

    async fn size(&self, path: &str) -> Option<u64> {
        let sftp = self.sftp.lock().await;
        sftp.metadata(path).await.ok().and_then(|m| m.size)
    }

    /// WRITE alone: no truncate, and deliberately not APPEND, which on a
    /// server that honours it writes at the end whatever offset was asked for.
    async fn open_write_at(&self, path: &str, offset: u64) -> Result<Self::Writer> {
        use russh_sftp::protocol::OpenFlags;
        use tokio::io::AsyncSeekExt;
        let mut file = {
            let sftp = self.sftp.lock().await;
            sftp.open_with_flags(path, OpenFlags::WRITE)
                .await
                .with_context(|| path.to_string())?
        };
        file.seek(std::io::SeekFrom::Start(offset))
            .await
            .with_context(|| path.to_string())?;
        Ok(file)
    }

    async fn digest_prefix(&self, path: &str, len: u64) -> Result<String> {
        let command = format!("head -c {len} -- {} | sha256sum", super::remote_exec::quote(path));
        let out = super::remote_exec::run_capture(self.opener.as_ref(), "sha256sum", &command).await?;
        let digest = out
            .split_whitespace()
            .next()
            .context("The server said nothing about the unfinished file")?;
        Ok(digest.to_string())
    }

    /// In batches, because one exec per file would cost a channel each and
    /// a directory resumed after a dropped connection can be hundreds.
    async fn digests(&self, paths: &[String]) -> Result<HashMap<String, String>> {
        let mut out = HashMap::new();
        for batch in paths.chunks(DIGEST_BATCH) {
            let command = super::remote_exec::sha256sum_command(batch.iter().map(String::as_str));
            let said = super::remote_exec::run_capture(self.opener.as_ref(), "sha256sum", &command).await?;
            for line in super::remote_exec::digest_lines(&said) {
                // Keyed by the path as given, which is what the caller holds.
                let (path, digest) = line?;
                out.insert(path.to_string(), digest.to_string());
            }
        }
        Ok(out)
    }

    /// The remove comes first because SSH_FXP_RENAME does not replace: an
    /// OpenSSH server refuses the rename outright when the target is there.
    async fn rename(&self, from: &str, to: &str) -> Result<()> {
        let sftp = self.sftp.lock().await;
        let _ = sftp.remove_file(to).await;
        sftp.rename(from.to_string(), to.to_string())
            .await
            .with_context(|| format!("renaming {from} to {to}"))
    }

    // Dropping a russh_sftp File sends the CLOSE without waiting for it, and
    // that path never decrements the client's count of open handles. Only the
    // awaited close, reached through shutdown, does. The client refuses to
    // open anything once that count reaches the limit the server advertised,
    // so a transfer that only ever dropped its files failed with "handle limit
    // reached" a few hundred files into a directory and took the session with
    // it. No lock: the handle belongs to the file, not the session.
    async fn close_read(&self, mut reader: Self::Reader) {
        use tokio::io::AsyncWriteExt;
        let _ = reader.shutdown().await;
    }

    async fn close_write(&self, mut writer: Self::Writer) -> Result<()> {
        use tokio::io::AsyncWriteExt;
        writer.shutdown().await.context("closing the file on the server")
    }

    fn join(&self, dir: &str, rel: &str) -> String {
        join_remote(dir, rel)
    }

    async fn remove_file(&self, path: &str) {
        let sftp = self.sftp.lock().await;
        let _ = sftp.remove_file(path).await;
    }
}

/// How many paths go into one `sha256sum`. The same batch size the tree
/// comparison uses, for the same reason: a command line has a limit.
const DIGEST_BATCH: usize = 200;

/// The suffix an unfinished file wears while it waits to be continued.
///
/// A half written file under its real name is indistinguishable from a whole
/// one: to `exists`, to the conflict policy, to the file browser and to the
/// person looking at the directory. The suffix is what makes "this is only
/// part of a file" a fact anything can read.
pub(super) const PART: &str = ".bifrossh-part";

pub(super) fn part_path(dst_path: &str) -> String {
    format!("{dst_path}{PART}")
}

/// Whether a name is an unfinished file rather than a file. Verification and
/// comparison ignore these: they belong to a transfer that has not happened
/// yet, and counting them would report the destination as holding a file the
/// source does not have.
pub(super) fn is_part(name: &str) -> bool {
    name.ends_with(PART)
}

/// What one file's copy ended as, and what it left behind.
pub(super) struct Outcome {
    pub step: Step,
    /// An unfinished file was kept at `<destination>.bifrossh-part`.
    pub part: bool,
    /// Why it stopped, where it stopped for a reason other than the user.
    pub error: Option<String>,
    /// The copy started part way in, continuing an earlier attempt.
    pub resumed: bool,
}

/// Where a resumed copy starts: the length of the unfinished file, when that
/// is a sensible prefix of the file being copied.
///
/// Anything else starts at zero. A part as long as the source, or longer, is
/// not the beginning of what is about to be written, whatever it is.
fn resume_offset(part: Option<u64>, total: u64) -> u64 {
    match part {
        Some(n) if n > 0 && n < total => n,
        _ => 0,
    }
}

/// What to do with a file that is already at the destination.
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Conflict {
    Overwrite,
    Skip,
    KeepBoth,
    /// Continue an unfinished file where one is there, and copy over anything
    /// else. What a stopped transfer is run again with.
    Resume,
}

/// `name` split into what comes before its last dot and the dot onward:
/// `notes.txt` is `("notes", ".txt")`, `archive.tar.gz` is
/// `("archive.tar", ".gz")`. A dotfile and a name with no dot have no
/// extension to keep, so the number goes at the end.
fn stem_and_ext(name: &str) -> (&str, &str) {
    match name.rfind('.') {
        Some(0) | None => (name, ""),
        Some(cut) => (&name[..cut], &name[cut..]),
    }
}

/// `name (2)`, then `name (3)`, and so on: the first one not already at
/// the destination.
async fn free_path<D: FileSide>(dst: &D, dir: &str, name: &str) -> String {
    let (stem, ext) = stem_and_ext(name);
    for n in 2.. {
        let candidate = dst.join(dir, &format!("{stem} ({n}){ext}"));
        if !dst.exists(&candidate).await {
            return candidate;
        }
    }
    unreachable!("an unbounded range")
}

/// Where a file goes under `policy`, or None when it is to be skipped.
///
/// `dir` and `name` are the destination directory and the file's name in
/// it; the two are joined here rather than by the caller because a kept
/// copy needs a different name and only this function knows which.
async fn resolve_conflict<D: FileSide>(dst: &D, dir: &str, name: &str, policy: Conflict) -> Option<String> {
    let wanted = dst.join(dir, name);
    // Resuming aims at the same name a plain overwrite would: the unfinished
    // file is beside it, and what is already there is what the resume
    // continues or replaces.
    if matches!(policy, Conflict::Overwrite | Conflict::Resume) || !dst.exists(&wanted).await {
        return Some(wanted);
    }
    match policy {
        Conflict::Skip => None,
        Conflict::KeepBoth => Some(free_path(dst, dir, name).await),
        Conflict::Overwrite | Conflict::Resume => Some(wanted),
    }
}

/// What the batch around one file asks of it: where it sits in the run, what
/// to do about anything already at the destination, and the flag that stops it.
struct Job<'a> {
    at: Position,
    policy: Conflict,
    cancel: &'a AtomicBool,
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
    app: &impl Progress,
    src: &S,
    src_path: &str,
    dst: &D,
    dst_path: &str,
    job: Job<'_>,
) -> Result<Outcome> {
    let Job { at, policy, cancel } = job;
    use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

    let file_name = Path::new(dst_path)
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .into_owned();

    let (mut reader, total) = src.open_read(src_path).await?;
    let part = part_path(dst_path);

    // What is already there is only worth keeping if it is the beginning of
    // what is about to be written. Both digests are computed where their file
    // lives, so this costs a read on each machine and nothing on the wire.
    let mut offset = 0u64;
    if policy == Conflict::Resume {
        offset = resume_offset(dst.size(&part).await, total);
        if offset > 0 {
            let here = src.digest_prefix(src_path, offset).await;
            let there = dst.digest_prefix(&part, offset).await;
            let same = matches!((&here, &there), (Ok(a), Ok(b)) if a == b);
            if !same {
                offset = 0;
            }
        }
    }
    if offset == 0 {
        // Whatever is in that part file belongs to a different copy of this
        // path. Left alone under Skip and Keep both, which are not writing
        // over the file it sits beside.
        if matches!(policy, Conflict::Overwrite | Conflict::Resume) {
            dst.remove_file(&part).await;
        }
    } else {
        reader
            .seek(std::io::SeekFrom::Start(offset))
            .await
            .with_context(|| src_path.to_string())?;
    }

    let mut writer = if offset > 0 {
        dst.open_write_at(&part, offset).await?
    } else {
        dst.create_write(dst_path).await?
    };

    // Held outside the copy so the failure path below can ask whether anything
    // arrived, which is what decides between keeping a part file and removing
    // an empty stub. It counts from the resume point, so the progress the
    // window sees is the position in the file rather than in this attempt.
    let mut transferred = offset;
    let outcome = async {
        let mut buf = vec![0u8; CHUNK];
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
            app.report(TransferProgress {
                transfer_id: String::new(),
                file_name: file_name.clone(),
                transferred,
                total,
                resumed_from: offset,
                file_index: at.index,
                file_count: at.count,
            });
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

    // Closed on every path, not dropped. On the remote side the difference is
    // whether the server's handle is counted as released; see Remote.
    src.close_read(reader).await;

    match outcome {
        Ok(Step::Finished) => {
            dst.close_write(writer).await?;
            // A resumed file finishes under the part name and takes the real
            // one only now that it is whole.
            if offset > 0 {
                dst.rename(&part, dst_path).await?;
            }
            Ok(Outcome {
                step: Step::Finished,
                part: false,
                error: None,
                resumed: offset > 0,
            })
        }
        // A part written file is not a shorter file, and leaving it under the
        // real name puts something that looks complete beside the files that
        // are. It is still the bytes the network already carried, so it is
        // moved aside under the part suffix rather than thrown away, and only
        // an empty stub is removed. The close comes first so the server is not
        // asked to move a file it still holds open.
        other => {
            let _ = dst.close_write(writer).await;
            // A resume was already writing into the part file, so there is
            // nothing to move: it simply grew and stopped again.
            let kept = if offset > 0 {
                true
            } else {
                transferred > 0 && dst.rename(dst_path, &part).await.is_ok()
            };
            if !kept {
                dst.remove_file(dst_path).await;
            }
            // A file that broke is reported rather than returned as an
            // error, so the batch around it can say what it managed and what
            // it kept.
            match other {
                Ok(step) => Ok(Outcome { step, part: kept, error: None, resumed: false }),
                Err(e) => Ok(Outcome {
                    step: Step::Failed,
                    part: kept,
                    error: Some(format!("{e:#}")),
                    resumed: false,
                }),
            }
        }
    }
}

/// Reads every resumed file back, both sides, and names the ones that do not
/// match.
///
/// Forced, whatever the verification setting says. Everything else copied one
/// stream straight through; a resumed file is two attempts joined at a byte
/// nobody watched, so it is the one case where "it arrived" is worth proving
/// rather than assuming.
///
/// `done` holds, per file, the source path, the path it landed at, and the
/// path relative to the transfer root that names it to the user. A digest
/// that could not be taken counts as a mismatch: not being able to prove a
/// file is right and knowing it is wrong call for the same answer.
async fn check_resumed<S: FileSide, D: FileSide>(
    src: &S,
    dst: &D,
    done: &[(String, String, String)],
) -> (Vec<String>, Option<String>) {
    if done.is_empty() {
        return (Vec::new(), None);
    }
    let here: Vec<String> = done.iter().map(|(s, _, _)| s.clone()).collect();
    let there: Vec<String> = done.iter().map(|(_, d, _)| d.clone()).collect();
    let all = || done.iter().map(|(_, _, rel)| rel.clone()).collect::<Vec<_>>();

    let sent = match src.digests(&here).await {
        Ok(d) => d,
        Err(e) => return (all(), Some(format!("Could not check the resumed files: {e:#}"))),
    };
    let arrived = match dst.digests(&there).await {
        Ok(d) => d,
        Err(e) => return (all(), Some(format!("Could not check the resumed files: {e:#}"))),
    };

    let mut mismatched = Vec::new();
    for (src_path, dst_path, rel) in done {
        match (sent.get(src_path), arrived.get(dst_path)) {
            (Some(a), Some(b)) if a == b => {}
            _ => mismatched.push(rel.clone()),
        }
    }
    (mismatched, None)
}

/// Copies `src_path` into `dst_dir`, recursing if it names a directory.
///
/// The destination keeps the source's own name, so this is "drop it in here"
/// rather than "write it as this".
async fn transfer<S: FileSide, D: FileSide>(
    app: &impl Progress,
    src: &S,
    src_path: &str,
    dst: &D,
    dst_dir: &str,
    policy: Conflict,
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
    if !src.is_dir(src_path).await? {
        let wanted = dst.join(dst_dir, &name);
        let Some(dest) = resolve_conflict(dst, dst_dir, &name, policy).await else {
            return Ok(TransferSummary { skipped_existing: 1, ..Default::default() });
        };
        let at = Position { index: 1, count: 1 };
        let job = Job { at, policy, cancel };
        let outcome = transfer_one(app, src, src_path, dst, &dest, job).await?;
        let done = match outcome.resumed && outcome.step == Step::Finished {
            true => vec![(src_path.to_string(), dest.clone(), String::new())],
            false => Vec::new(),
        };
        let (mismatched, check_failed) = check_resumed(src, dst, &done).await;
        return Ok(TransferSummary {
            renamed: u32::from(dest != wanted),
            resumed: u32::from(outcome.resumed),
            mismatched,
            resumable: u32::from(outcome.part && dest == wanted),
            failed: outcome.error.or(check_failed),
            landed: Some(dest),
            ..single_file_summary(outcome.step)
        });
    }
    let dest_root = dst.join(dst_dir, &name);

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

    let mut skipped_existing = 0u32;
    let mut renamed = 0u32;
    let mut resumable = 0u32;
    let mut resumed = 0u32;
    let mut resumed_files: Vec<(String, String, String)> = Vec::new();
    let mut files_done = 0u32;
    let mut cancelled = false;
    let mut failed = None;
    for (i, item) in files.iter().enumerate() {
        let at = Position { index: i as u32 + 1, count };
        // A file under a directory: its parent within the tree and its own
        // name, so a kept copy is renamed and not its whole path.
        let (rel_dir, file_name) = match item.rel.rfind('/') {
            Some(cut) => (dst.join(&dest_root, &item.rel[..cut]), &item.rel[cut + 1..]),
            None => (dest_root.clone(), item.rel.as_str()),
        };
        let wanted = dst.join(&rel_dir, file_name);
        let Some(dest) = resolve_conflict(dst, &rel_dir, file_name, policy).await else {
            skipped_existing += 1;
            continue;
        };
        // A kept copy lands under a name of its own, so the two trees are
        // no longer the same tree and nothing should compare them.
        if dest != wanted { renamed += 1; }
        // An error opening the source or the destination never reached the
        // copy, so there is nothing kept and nothing to report but the error.
        let outcome = match transfer_one(
            app,
            src,
            &src.join(src_path, &item.rel),
            dst,
            &dest,
            Job { at, policy, cancel },
        )
        .await
        {
            Ok(outcome) => outcome,
            Err(e) => {
                failed = Some(format!("{e:#}"));
                break;
            }
        };
        if outcome.part && dest == wanted {
            resumable += 1;
        }
        if outcome.resumed {
            resumed += 1;
            if outcome.step == Step::Finished {
                resumed_files.push((src.join(src_path, &item.rel), dest.clone(), item.rel.clone()));
            }
        }
        // Files already copied are left alone; only the one in flight is
        // unfinished. `files` therefore counts what actually arrived, which
        // is why it is counted here rather than worked out from the position
        // the batch stopped at.
        match outcome.step {
            Step::Finished => files_done += 1,
            Step::Cancelled => {
                cancelled = true;
                break;
            }
            Step::Failed => {
                failed = outcome.error;
                break;
            }
        }
    }

    let (mismatched, check_failed) = check_resumed(src, dst, &resumed_files).await;
    Ok(TransferSummary {
        files: files_done,
        directories,
        skipped_symlinks,
        skipped_existing,
        renamed,
        resumed,
        mismatched,
        resumable,
        cancelled,
        landed: Some(dest_root),
        verified: 0,
        failed: failed.or(check_failed),
    })
}

/// Copies just the named files of a tree again, over whatever is there.
///
/// `rels` are paths relative to the transfer root, the vocabulary the rest of
/// this module already speaks: the empty string is the transferred file
/// itself. What the user gets after being told which resumed files did not
/// match and choosing to send them again.
async fn transfer_only<S: FileSide, D: FileSide>(
    app: &impl Progress,
    src: &S,
    src_root: &str,
    dst: &D,
    dest_root: &str,
    rels: &[String],
    cancel: &AtomicBool,
) -> Result<TransferSummary> {
    let count = rels.len() as u32;
    let mut files_done = 0u32;
    let mut resumable = 0u32;
    let mut cancelled = false;
    let mut failed = None;

    for (i, rel) in rels.iter().enumerate() {
        let (src_path, dst_path) = if rel.is_empty() {
            (src_root.to_string(), dest_root.to_string())
        } else {
            (src.join(src_root, rel), dst.join(dest_root, rel))
        };
        // The tree is already there, but a directory could have been removed
        // between the transfer and the answer to the dialog.
        if let Some(cut) = rel.rfind('/') {
            dst.ensure_dir(&dst.join(dest_root, &rel[..cut])).await?;
        }
        let at = Position { index: i as u32 + 1, count };
        let job = Job { at, policy: Conflict::Overwrite, cancel };
        let outcome = match transfer_one(app, src, &src_path, dst, &dst_path, job).await {
            Ok(outcome) => outcome,
            Err(e) => {
                failed = Some(format!("{e:#}"));
                break;
            }
        };
        if outcome.part {
            resumable += 1;
        }
        match outcome.step {
            Step::Finished => files_done += 1,
            Step::Cancelled => {
                cancelled = true;
                break;
            }
            Step::Failed => {
                failed = outcome.error;
                break;
            }
        }
    }

    Ok(TransferSummary {
        files: files_done,
        resumable,
        cancelled,
        landed: Some(dest_root.to_string()),
        failed,
        ..Default::default()
    })
}

/// The names, relative to `src_path`, of files a transfer would find
/// already at the destination. What the panel asks before it asks the user.
pub(super) async fn conflicts<S: FileSide, D: FileSide>(
    src: &S,
    src_path: &str,
    dst: &D,
    dst_dir: &str,
) -> Result<Vec<String>> {
    let name = Path::new(src_path)
        .file_name()
        .context("Invalid source path")?
        .to_string_lossy()
        .into_owned();
    if !src.is_dir(src_path).await? {
        let there = dst.exists(&dst.join(dst_dir, &name)).await;
        return Ok(if there { vec![name] } else { vec![] });
    }
    let dest_root = dst.join(dst_dir, &name);
    let (items, _) = src.walk(src_path).await?;
    let mut found = Vec::new();
    for item in items.iter().filter(|i| !i.is_dir) {
        if dst.exists(&dst.join(&dest_root, &item.rel)).await {
            found.push(item.rel.clone());
        }
    }
    Ok(found)
}

/// Which pairing a conflict check or transfer is for.
pub enum Pairing {
    Upload { session_id: String },
    Download { session_id: String },
    Copy { src_session_id: String, dst_session_id: String },
}

pub async fn conflicts_for(
    sftp_state: &SftpClientState,
    pairing: Pairing,
    src_path: &str,
    dst_dir: &str,
) -> Result<Vec<String>> {
    match pairing {
        Pairing::Upload { session_id } => {
            let remote = remote_side(sftp_state, &session_id).await?;
            conflicts(&Local, src_path, &remote, dst_dir).await
        }
        Pairing::Download { session_id } => {
            let remote = remote_side(sftp_state, &session_id).await?;
            conflicts(&remote, src_path, &Local, dst_dir).await
        }
        Pairing::Copy { src_session_id, dst_session_id } => {
            let src = remote_side(sftp_state, &src_session_id).await?;
            let dst = remote_side(sftp_state, &dst_session_id).await?;
            conflicts(&src, src_path, &dst, dst_dir).await
        }
    }
}

/// Copies the named files of a finished transfer again, in whichever
/// pairing it ran.
pub async fn recopy_paths(
    app: &impl Progress,
    sftp_state: &SftpClientState,
    transfer_id: &str,
    pairing: Pairing,
    src_path: &str,
    dest_root: &str,
    rels: &[String],
) -> Result<TransferSummary> {
    let guard = sftp_state.begin_transfer(transfer_id);
    match pairing {
        Pairing::Upload { session_id } => {
            let remote = remote_side(sftp_state, &session_id).await?;
            transfer_only(app, &Local, src_path, &remote, dest_root, rels, &guard.cancel).await
        }
        Pairing::Download { session_id } => {
            let remote = remote_side(sftp_state, &session_id).await?;
            transfer_only(app, &remote, src_path, &Local, dest_root, rels, &guard.cancel).await
        }
        Pairing::Copy { src_session_id, dst_session_id } => {
            let src = remote_side(sftp_state, &src_session_id).await?;
            let dst = remote_side(sftp_state, &dst_session_id).await?;
            transfer_only(app, &src, src_path, &dst, dest_root, rels, &guard.cancel).await
        }
    }
}

/// Uploads a file, or a directory tree rooted at `local_path`.
pub async fn upload_path(
    app: &impl Progress,
    sftp_state: &SftpClientState,
    transfer_id: &str,
    session_id: &str,
    local_path: &str,
    remote_dir: &str,
    policy: Conflict,
) -> Result<TransferSummary> {
    let remote = remote_side(sftp_state, session_id).await?;
    let guard = sftp_state.begin_transfer(transfer_id);
    transfer(app, &Local, local_path, &remote, remote_dir, policy, &guard.cancel).await
}

/// Uploads one file with no progress and no place in the panel's queue,
/// which is what an upload behind an editor's save is: nothing the user
/// can see or cancel. It carries its own flag nobody raises.
pub(super) async fn upload_quiet(
    sftp_state: &SftpClientState,
    session_id: &str,
    local_path: &str,
    remote_dir: &str,
) -> Result<()> {
    let remote = remote_side(sftp_state, session_id).await?;
    let cancel = AtomicBool::new(false);
    transfer(&Silent, &Local, local_path, &remote, remote_dir, Conflict::Overwrite, &cancel).await?;
    Ok(())
}

/// Downloads a file, or a directory tree rooted at `remote_path`.
pub async fn download_path(
    app: &impl Progress,
    sftp_state: &SftpClientState,
    transfer_id: &str,
    session_id: &str,
    remote_path: &str,
    local_dir: &str,
    policy: Conflict,
) -> Result<TransferSummary> {
    let remote = remote_side(sftp_state, session_id).await?;
    let guard = sftp_state.begin_transfer(transfer_id);
    transfer(app, &remote, remote_path, &Local, local_dir, policy, &guard.cancel).await
}

/// Copies a file, or a directory tree, between two remote sessions.
// Two sessions, two paths, a policy and an id: the eighth is the id, and
// a params struct for one call would say less than the list does.
#[allow(clippy::too_many_arguments)]
pub async fn copy_remote_path(
    app: &impl Progress,
    sftp_state: &SftpClientState,
    transfer_id: &str,
    src_session_id: &str,
    src_path: &str,
    dst_session_id: &str,
    dst_dir: &str,
    policy: Conflict,
) -> Result<TransferSummary> {
    let src = remote_side(sftp_state, src_session_id).await?;
    let dst = remote_side(sftp_state, dst_session_id).await?;
    let guard = sftp_state.begin_transfer(transfer_id);
    transfer(app, &src, src_path, &dst, dst_dir, policy, &guard.cancel).await
}

#[cfg(test)]
mod tests {
    /// Only a part shorter than the file it belongs to is a prefix of it.
    /// One the same length or longer is something else entirely.
    #[test]
    fn a_resume_starts_where_the_unfinished_file_ends() {
        use super::resume_offset;
        assert_eq!(resume_offset(None, 100), 0);
        assert_eq!(resume_offset(Some(0), 100), 0);
        assert_eq!(resume_offset(Some(40), 100), 40);
        assert_eq!(resume_offset(Some(100), 100), 0);
        assert_eq!(resume_offset(Some(140), 100), 0);
    }

    /// Every resumed file is read back whole, because a resume joins two
    /// attempts at a byte nobody watched. A digest that cannot be taken at
    /// all counts against the file: not being able to prove it arrived and
    /// knowing it did not deserve the same answer.
    #[tokio::test]
    async fn a_resumed_file_is_named_when_it_does_not_match_what_was_sent() {
        use super::{check_resumed, Local};
        let dir = std::env::temp_dir().join(format!("bifrossh-check-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = |n: &str| dir.join(n).to_string_lossy().into_owned();
        std::fs::write(dir.join("src.bin"), b"the same bytes").unwrap();
        std::fs::write(dir.join("same.bin"), b"the same bytes").unwrap();
        std::fs::write(dir.join("other.bin"), b"other bytes!!!").unwrap();

        let matched = [(path("src.bin"), path("same.bin"), "a.bin".to_string())];
        let (mismatched, failed) = check_resumed(&Local, &Local, &matched).await;
        assert!(mismatched.is_empty());
        assert!(failed.is_none());

        let differing = [(path("src.bin"), path("other.bin"), "a.bin".to_string())];
        let (mismatched, failed) = check_resumed(&Local, &Local, &differing).await;
        assert_eq!(mismatched, vec!["a.bin".to_string()]);
        assert!(failed.is_none());

        let missing = [(path("src.bin"), path("gone.bin"), String::new())];
        let (mismatched, failed) = check_resumed(&Local, &Local, &missing).await;
        assert_eq!(mismatched, vec![String::new()]);
        assert!(failed.is_some(), "the reason the check could not be made is kept");

        // Nothing resumed, nothing read back.
        let (mismatched, failed) = check_resumed(&Local, &Local, &[]).await;
        assert!(mismatched.is_empty() && failed.is_none());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The suffix goes on the end of the whole name, extension included, so
    /// the part of `notes.txt` cannot be mistaken for a text file.
    #[test]
    fn an_unfinished_file_is_named_after_the_one_it_will_become() {
        use super::part_path;
        assert_eq!(part_path("/tmp/notes.txt"), "/tmp/notes.txt.bifrossh-part");
        assert_eq!(part_path("/tmp/archive.tar.gz"), "/tmp/archive.tar.gz.bifrossh-part");
    }

    /// The number goes before the extension, so a kept copy still opens
    /// with the same application. A dotfile has no extension to keep.
    #[test]
    fn a_kept_copy_is_numbered_before_its_extension() {
        use super::stem_and_ext;
        assert_eq!(stem_and_ext("notes.txt"), ("notes", ".txt"));
        assert_eq!(stem_and_ext("archive.tar.gz"), ("archive.tar", ".gz"));
        assert_eq!(stem_and_ext("Makefile"), ("Makefile", ""));
        assert_eq!(stem_and_ext(".bashrc"), (".bashrc", ""));
        assert_eq!(stem_and_ext("trailing."), ("trailing", "."));
    }

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
