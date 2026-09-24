//! The two ends a transfer can have, behind one trait.
//!
//! The three transfers the panel offers are the three pairings of a local
//! disk and a remote SFTP session: upload is local to remote, download is
//! remote to local, and a copy between panes is remote to remote. The engine
//! in `transfer` is written once against this trait, so the chunked copy
//! loop, the tree walk and the resume bookkeeping exist once rather than
//! three times.

use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use async_trait::async_trait;
use russh_sftp::client::SftpSession;
use tokio::sync::Mutex;

use super::listing::{collect_local_tree, collect_remote_tree};
use super::remote_exec;
use super::session::{get_opener, get_session};
use super::{join_remote, ChannelOpener, SftpClientState, TreeItem};

/// How many paths go into one `sha256sum`. The same batch size the tree
/// comparison uses, for the same reason: a command line has a limit.
const DIGEST_BATCH: usize = 200;

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
        let command = format!("head -c {len} -- {} | sha256sum", remote_exec::quote(path));
        let out = remote_exec::run_capture(self.opener.as_ref(), "sha256sum", &command).await?;
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
            let command = remote_exec::sha256sum_command(batch.iter().map(String::as_str));
            let said = remote_exec::run_capture(self.opener.as_ref(), "sha256sum", &command).await?;
            for line in remote_exec::digest_lines(&said) {
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
