//! Moving a directory as one compressed stream.
//!
//! SFTP costs a round trip per file, which a directory of ten thousand
//! small files feels as minutes of waiting. `tar` turns the same work
//! into one stream, in all three directions a transfer can go: down from
//! a server, up to one, and from one server to another, where the bytes
//! are pumped between two channels and never touch this disk. What lands
//! is the directory itself, not an archive to open afterwards.
//!
//! No server is trusted with where the bytes go. On the way down every
//! entry's path is checked before it is written, the way `is_safe_name`
//! guards a listing, because a hostile archive would otherwise be free to
//! write anywhere the app can. On the way up the destination unpacks with
//! its own tar, into a directory the user chose.

use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::Ordering;

use anyhow::{anyhow, bail, Context, Result};
use russh::ChannelMsg;

use super::listing::parent_remote;
use super::session::get_opener;
use super::transfer::Progress;
use super::{join_remote, SftpClientState, TransferProgress, TransferSummary};

/// A path or a name as a single shell word.
///
/// The command is one string handed to the server's shell, so a directory
/// called `a b` or `don't` has to survive it. Single quotes take
/// everything literally; the only character that needs care is the quote
/// itself, which is closed, escaped and reopened.
pub(super) fn quote(word: &str) -> String {
    format!("'{}'", word.replace('\'', r"'\''"))
}

/// The last segment of a remote path: what tar is asked to pack.
fn remote_name(remote_path: &str) -> &str {
    let trimmed = remote_path.trim_end_matches('/');
    trimmed.rsplit('/').next().unwrap_or(trimmed)
}

/// Packs one directory or file, from its parent, to stdout.
pub(super) fn tar_command(remote_path: &str) -> String {
    format!(
        "tar czf - -C {} -- {}",
        quote(&parent_remote(remote_path)),
        quote(remote_name(remote_path)),
    )
}

/// Unpacks stdin into a directory, which is made first if it is not there.
pub(super) fn untar_command(remote_dir: &str) -> String {
    format!("mkdir -p {dir} && tar xzf - -C {dir}", dir = quote(remote_dir))
}

/// The same, landing under another name.
///
/// The archive carries the source's own top-level name, and neither
/// `--transform` nor `--strip-components` is portable enough to rely on,
/// so it is unpacked into a staging directory beside the destination and
/// moved into place. The staging name is the new one with a suffix, so
/// nothing that was already there is touched.
pub(super) fn staged_untar_command(remote_dir: &str, old_name: &str, new_name: &str) -> String {
    let stage = format!("{remote_dir}/.bifrossh-{new_name}");
    format!(
        "mkdir -p {stage} && tar xzf - -C {stage} && mv {from} {to} && rmdir {stage}",
        stage = quote(&stage),
        from = quote(&format!("{stage}/{old_name}")),
        to = quote(&format!("{remote_dir}/{new_name}")),
    )
}

/// The archive's path with its first component swapped for `name`.
fn rename_top(path: &Path, name: &str) -> PathBuf {
    let mut parts = path.components();
    match parts.next() {
        Some(_) => Path::new(name).join(parts.as_path()),
        None => PathBuf::from(name),
    }
}

/// Whether an entry from the archive may be written under the destination.
///
/// Anything absolute, anything climbing out with `..`, and anything with
/// a Windows prefix is refused. The check is on the path as the archive
/// gives it, before it is joined onto anything.
pub(super) fn safe_entry_path(path: &Path) -> bool {
    !path.components().any(|c| !matches!(c, Component::Normal(_) | Component::CurDir))
}

/// Downloads `remote_path` as a tar stream and unpacks it into `local_dir`.
#[allow(clippy::too_many_arguments)]
pub async fn download_archive(
    app: &impl Progress,
    sftp_state: &SftpClientState,
    transfer_id: &str,
    session_id: &str,
    remote_path: &str,
    local_dir: &str,
    // `into_name` is what the unpacked directory is called here; None
    // keeps the name it has on the server, and it is set when the user
    // asked to keep both copies.
    into_name: Option<&str>,
) -> Result<TransferSummary> {
    let opener = get_opener(sftp_state, session_id).await?;
    let guard = sftp_state.begin_transfer(transfer_id);
    let cancel = guard.cancel.clone();

    let name = remote_path.trim_end_matches('/').rsplit('/').next().unwrap_or(remote_path).to_string();
    let dest = PathBuf::from(local_dir);
    std::fs::create_dir_all(&dest).with_context(|| dest.display().to_string())?;

    let mut channel = opener.open_session().await.context("Could not open a channel for tar")?;
    channel
        .exec(true, tar_command(remote_path))
        .await
        .context("The server refused to run tar")?;

    // tar and flate2 are blocking, so the unpacking runs on its own thread
    // and is fed through a pipe. The reader end owns the unpack; this task
    // only pushes bytes into the writer end.
    let (reader, mut writer) = os_pipe::pipe().context("Could not open a pipe for the archive")?;
    let unpack_dest = dest.clone();
    let rename_to = into_name.map(str::to_owned);
    let unpack = tokio::task::spawn_blocking(move || unpack_into(reader, &unpack_dest, rename_to.as_deref()));

    let mut transferred = 0u64;
    let mut stderr = String::new();
    let mut status = None;
    let mut write_err: Option<io::Error> = None;

    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { ref data } => {
                if cancel.load(Ordering::Relaxed) { break; }
                // A write failing means the unpacker stopped, and its own
                // error is the one worth reporting, so the loop ends here
                // and the error is picked up below.
                if let Err(e) = writer.write_all(data) { write_err = Some(e); break; }
                transferred += data.len() as u64;
                app.report(TransferProgress {
                    transfer_id: String::new(),
                    file_name: name.clone(),
                    transferred,
                    // Nothing knows the size of a stream that is still
                    // being produced; the panel shows bytes so far.
                    total: 0,
                    file_index: 1,
                    file_count: 1,
                });
            }
            ChannelMsg::ExtendedData { ref data, .. } => {
                stderr.push_str(&String::from_utf8_lossy(data));
            }
            ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
            // Not Eof: the exit status arrives after it, and breaking on
            // the first of the two lost the reason tar gave for failing.
            ChannelMsg::Close => break,
            _ => {}
        }
    }
    let cancelled = cancel.load(Ordering::Relaxed);
    drop(writer);
    let unpacked = unpack.await.map_err(|e| anyhow!("The unpacker stopped: {e}"))?;
    let _ = channel.close().await;

    if cancelled {
        // What arrived stays on the disk, as with a cancelled copy.
        return Ok(TransferSummary { cancelled: true, ..Default::default() });
    }
    if let Some(e) = write_err {
        let detail = unpacked.err().map(|e| format!("{e:#}")).unwrap_or_else(|| e.to_string());
        bail!("The archive could not be unpacked: {detail}");
    }
    let (files, directories) = unpacked?;
    // tar says what went wrong; a missing tar, an unreadable directory.
    if let Some(e) = exec_failure("tar on the server", "tar", status, &stderr) { return Err(e); }
    let landed = dest.join(into_name.unwrap_or(&name));
    Ok(TransferSummary {
        files,
        directories,
        landed: Some(landed.to_string_lossy().into_owned()),
        ..Default::default()
    })
}

/// Unpacks a gzipped tar from `reader` into `dest`, refusing any entry
/// that would land outside it. Blocking; runs on its own thread.
fn unpack_into(reader: impl Read, dest: &Path, rename_to: Option<&str>) -> Result<(u32, u32)> {
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(reader));
    // Ownership and times come from the server's idea of who exists; the
    // files belong to whoever is running here.
    archive.set_preserve_permissions(false);
    archive.set_unpack_xattrs(false);

    let mut files = 0u32;
    let mut directories = 0u32;
    for entry in archive.entries().context("The archive could not be read")? {
        let mut entry = entry.context("The archive ended part way")?;
        let path = entry.path().context("The archive named a path this system cannot read")?.into_owned();
        if !safe_entry_path(&path) {
            bail!("The archive tried to write outside the destination: {}", path.display());
        }
        let is_dir = entry.header().entry_type().is_dir();
        // Keeping both copies means the tree lands under another name;
        // the archive's own top-level component is swapped for it.
        let path = match rename_to {
            Some(name) => rename_top(&path, name),
            None => path,
        };
        // unpack_in would use the archive's own path; the renamed one is
        // joined here instead. It is safe to join: the components were
        // checked above and the new top-level name is one the app chose.
        entry
            .unpack(dest.join(&path))
            .with_context(|| format!("Could not write {}", path.display()))?;
        if is_dir { directories += 1; } else { files += 1; }
    }
    Ok((files, directories))
}

/// What a finished exec channel said, if anything went wrong.
pub(super) fn exec_failure(
    what: &str,
    // The program that was run, for the one failure it cannot describe
    // itself: a shell that cannot find it says nothing on stderr.
    tool: &str,
    status: Option<u32>,
    stderr: &str,
) -> Option<anyhow::Error> {
    let code = status?;
    if code == 0 { return None; }
    let said = stderr.trim();
    Some(anyhow!(
        "{what} exited with status {code}{}",
        if said.is_empty() {
            format!(". The host may have no {tool} installed.")
        } else {
            format!(": {said}")
        },
    ))
}

/// Packs `local_path` into a gzipped tar written to `writer`. Blocking.
fn pack_from(local_path: &Path, writer: impl Write, pack_as: Option<&str>) -> Result<u32> {
    let parent = local_path.parent().unwrap_or(Path::new("."));
    let own_name = local_path.file_name().context("The path has no name to pack")?;
    // The name inside the archive is what the destination will call it,
    // which is how keeping both copies works on the way up.
    let name: &Path = pack_as.map(Path::new).unwrap_or_else(|| Path::new(own_name));
    let encoder = flate2::write::GzEncoder::new(writer, flate2::Compression::default());
    let mut builder = tar::Builder::new(encoder);
    builder.follow_symlinks(false);
    let full = parent.join(own_name);
    if full.is_dir() {
        builder.append_dir_all(name, &full).with_context(|| full.display().to_string())?;
    } else {
        builder.append_path_with_name(&full, name).with_context(|| full.display().to_string())?;
    }
    builder.into_inner()?.finish()?;
    // Counting entries would mean walking the tree twice; the panel only
    // reports surprises, and there are none here.
    Ok(0)
}

/// Uploads `local_path` as a tar stream the server unpacks itself.
#[allow(clippy::too_many_arguments)]
pub async fn upload_archive(
    app: &impl Progress,
    sftp_state: &SftpClientState,
    transfer_id: &str,
    session_id: &str,
    local_path: &str,
    remote_dir: &str,
    into_name: Option<&str>,
) -> Result<TransferSummary> {
    let opener = get_opener(sftp_state, session_id).await?;
    let guard = sftp_state.begin_transfer(transfer_id);
    let cancel = guard.cancel.clone();

    let source = PathBuf::from(local_path);
    let name = source.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| local_path.to_string());

    let mut channel = opener.open_session().await.context("Could not open a channel for tar")?;
    channel
        .exec(true, untar_command(remote_dir))
        .await
        .context("The server refused to run tar")?;

    // tar is blocking, so it packs on its own thread and the bytes come
    // back through a pipe to be sent down the channel.
    let (mut reader, writer) = os_pipe::pipe().context("Could not open a pipe for the archive")?;
    let pack_as = into_name.map(str::to_owned);
    let packing = tokio::task::spawn_blocking(move || pack_from(&source, writer, pack_as.as_deref()));

    let mut sent = 0u64;
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        if cancel.load(Ordering::Relaxed) { break; }
        // The pipe read is blocking; a chunk at a time keeps the cancel
        // flag looked at often enough without a second thread.
        let (n, giveback) = tokio::task::spawn_blocking(move || {
            let n = reader.read(&mut buf);
            (n, (reader, buf))
        })
        .await
        .map_err(|e| anyhow!("The packer stopped: {e}"))?;
        let (r, b) = giveback;
        reader = r;
        buf = b;
        let n = n.context("The archive could not be read back")?;
        if n == 0 { break; }
        channel.data(&buf[..n]).await.context("The archive could not be sent")?;
        sent += n as u64;
        app.report(TransferProgress {
            transfer_id: String::new(),
            file_name: name.clone(),
            transferred: sent,
            total: 0,
            file_index: 1,
            file_count: 1,
        });
    }
    let cancelled = cancel.load(Ordering::Relaxed);
    let _ = channel.eof().await;
    let packed = packing.await.map_err(|e| anyhow!("The packer stopped: {e}"))?;

    let (status, stderr) = drain_exec(&mut channel).await;
    let _ = channel.close().await;

    if cancelled {
        return Ok(TransferSummary { cancelled: true, ..Default::default() });
    }
    let files = packed?;
    if let Some(e) = exec_failure("tar on the server", "tar", status, &stderr) { return Err(e); }
    Ok(TransferSummary {
        files,
        landed: Some(join_remote(remote_dir, into_name.unwrap_or(&name))),
        ..Default::default()
    })
}

/// Copies a directory from one server to another as one stream: the
/// source tars to its stdout and the destination untars from its stdin,
/// with the bytes passing through here and never through this disk.
#[allow(clippy::too_many_arguments)]
pub async fn copy_archive(
    app: &impl Progress,
    sftp_state: &SftpClientState,
    transfer_id: &str,
    src_session_id: &str,
    src_path: &str,
    dst_session_id: &str,
    dst_dir: &str,
    into_name: Option<&str>,
) -> Result<TransferSummary> {
    let src_opener = get_opener(sftp_state, src_session_id).await?;
    let dst_opener = get_opener(sftp_state, dst_session_id).await?;
    let guard = sftp_state.begin_transfer(transfer_id);
    let cancel = guard.cancel.clone();
    let name = remote_name(src_path).to_string();

    let mut src = src_opener.open_session().await.context("Could not open a channel for tar")?;
    src.exec(true, tar_command(src_path)).await.context("The source server refused to run tar")?;
    let mut dst = dst_opener.open_session().await.context("Could not open a channel for tar")?;
    let command = match into_name {
        Some(new_name) => staged_untar_command(dst_dir, &name, new_name),
        None => untar_command(dst_dir),
    };
    dst.exec(true, command).await.context("The destination server refused to run tar")?;

    let mut moved = 0u64;
    let mut src_stderr = String::new();
    let mut src_status = None;
    while let Some(msg) = src.wait().await {
        match msg {
            ChannelMsg::Data { ref data } => {
                if cancel.load(Ordering::Relaxed) { break; }
                dst.data(&data[..]).await.context("The archive could not be sent on")?;
                moved += data.len() as u64;
                app.report(TransferProgress {
                    transfer_id: String::new(),
                    file_name: name.clone(),
                    transferred: moved,
                    total: 0,
                    file_index: 1,
                    file_count: 1,
                });
            }
            ChannelMsg::ExtendedData { ref data, .. } => src_stderr.push_str(&String::from_utf8_lossy(data)),
            ChannelMsg::ExitStatus { exit_status } => src_status = Some(exit_status),
            ChannelMsg::Close => break,
            _ => {}
        }
    }
    let cancelled = cancel.load(Ordering::Relaxed);
    let _ = dst.eof().await;
    let (dst_status, dst_stderr) = drain_exec(&mut dst).await;
    let _ = src.close().await;
    let _ = dst.close().await;

    if cancelled {
        return Ok(TransferSummary { cancelled: true, ..Default::default() });
    }
    if let Some(e) = exec_failure("tar on the source server", "tar", src_status, &src_stderr) { return Err(e); }
    if let Some(e) = exec_failure("tar on the destination server", "tar", dst_status, &dst_stderr) { return Err(e); }
    Ok(TransferSummary {
        landed: Some(join_remote(dst_dir, into_name.unwrap_or(&name))),
        ..Default::default()
    })
}

/// Reads what is left of an exec channel: its stderr and its exit status.
async fn drain_exec(channel: &mut russh::Channel<russh::client::Msg>) -> (Option<u32>, String) {
    let mut status = None;
    let mut stderr = String::new();
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::ExtendedData { ref data, .. } => stderr.push_str(&String::from_utf8_lossy(data)),
            ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
            ChannelMsg::Close => break,
            _ => {}
        }
    }
    (status, stderr)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_word_survives_the_servers_shell() {
        assert_eq!(quote("plain"), "'plain'");
        assert_eq!(quote("two words"), "'two words'");
        assert_eq!(quote("don't"), r"'don'\''t'");
        assert_eq!(quote("$(rm -rf /)"), "'$(rm -rf /)'");
    }

    #[test]
    fn the_command_tars_one_name_from_its_parent() {
        assert_eq!(tar_command("/var/log"), "tar czf - -C '/var' -- 'log'");
        assert_eq!(tar_command("/var/log/"), "tar czf - -C '/var' -- 'log'");
        assert_eq!(tar_command("/opt/a b"), "tar czf - -C '/opt' -- 'a b'");
        assert_eq!(tar_command("/top"), "tar czf - -C '/' -- 'top'");
    }

    /// The archive comes from a server, so its paths are no more trusted
    /// than the names in a listing are.
    #[test]
    fn the_command_unpacks_into_a_directory_it_makes_first() {
        assert_eq!(untar_command("/tmp/out"), "mkdir -p '/tmp/out' && tar xzf - -C '/tmp/out'");
        assert_eq!(untar_command("/a b"), "mkdir -p '/a b' && tar xzf - -C '/a b'");
    }

    /// The message a host without tar produces, which is the one case
    /// worth naming rather than leaving as a bare status.
    #[test]
    fn a_failing_tar_says_what_it_said_or_guesses_why() {
        assert!(exec_failure("tar on the server", "tar", Some(0), "").is_none());
        assert!(exec_failure("tar on the server", "tar", None, "").is_none());
        let e = exec_failure("tar on the server", "tar", Some(127), "").unwrap().to_string();
        assert!(e.contains("no tar installed"), "{e}");
        let e = exec_failure("tar on the server", "tar", Some(2), "tar: /x: Cannot open").unwrap().to_string();
        assert!(e.contains("Cannot open"), "{e}");
    }

    #[test]
    fn a_kept_copy_lands_under_its_new_name() {
        assert_eq!(rename_top(Path::new("tree/sub/f.txt"), "tree (2)"), Path::new("tree (2)/sub/f.txt"));
        assert_eq!(rename_top(Path::new("tree"), "tree (2)"), Path::new("tree (2)"));
        assert_eq!(
            staged_untar_command("/tmp/out", "tree", "tree (2)"),
            "mkdir -p '/tmp/out/.bifrossh-tree (2)' && tar xzf - -C '/tmp/out/.bifrossh-tree (2)' && mv '/tmp/out/.bifrossh-tree (2)/tree' '/tmp/out/tree (2)' && rmdir '/tmp/out/.bifrossh-tree (2)'",
        );
    }

    #[test]
    fn an_entry_may_not_leave_the_destination() {
        for bad in ["/etc/passwd", "../outside", "a/../../b", "/"] {
            assert!(!safe_entry_path(Path::new(bad)), "{bad} should have been refused");
        }
        for good in ["f.txt", "a/b/c.txt", "./a/b"] {
            assert!(safe_entry_path(Path::new(good)), "{good} is an ordinary entry");
        }
    }
}
