//! Copying files between a local disk and a remote one, in any pairing.

use super::*;
use super::listing::{collect_local_tree, collect_remote_tree};
use super::session::get_session;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use russh_sftp::client::SftpSession;
use tauri::Emitter;
use tokio::sync::Mutex;

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
/// Paths are `&str` on both sides, and both sides join them the same way. That
/// holds because the app is Linux only, so a local path is a POSIX path and
/// `join_remote` is correct for it too.
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
}

struct Local;

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

    let mut buf = vec![0u8; CHUNK];
    let mut transferred = 0u64;
    loop {
        if cancel.load(Ordering::Relaxed) {
            // A part written file is not a shorter file, it is a corrupt one,
            // and nothing here can resume it. Removing it is the honest
            // outcome; leaving it puts something that looks complete beside the
            // files that are.
            drop(writer);
            dst.remove_file(dst_path).await;
            return Ok(Step::Cancelled);
        }
        let n = reader.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n]).await?;
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
    writer.flush().await?;
    Ok(Step::Finished)
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
    // Refused rather than joined: `join_remote` would turn an empty directory
    // into an absolute path and write to the root of whichever side this is.
    if dst_dir.is_empty() {
        return Err(anyhow!("No destination directory"));
    }
    let dest_root = join_remote(dst_dir, &name);

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
        dst.ensure_dir(&join_remote(&dest_root, &item.rel)).await?;
        directories += 1;
    }

    for (i, item) in files.iter().enumerate() {
        let at = Position { index: i as u32 + 1, count };
        let step = transfer_one(
            app,
            src,
            &join_remote(src_path, &item.rel),
            dst,
            &join_remote(&dest_root, &item.rel),
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
