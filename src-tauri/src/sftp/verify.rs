//! Comparing what landed with what was sent.
//!
//! A transfer reports bytes and stops; nothing until now said whether the
//! copy is the same file. This reads both trees again and compares SHA-256
//! per file, which costs a full read of each side and is why it is off
//! unless the user turns it on.
//!
//! Only whole files are compared, and only when the two trees should be
//! identical: a transfer that skipped an existing file, kept a second copy
//! under another name, skipped a symlink or was cancelled leaves two trees
//! that legitimately differ, and is reported as not verified rather than as
//! a mismatch.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use anyhow::{anyhow, bail, Context, Result};
use russh::ChannelMsg;
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::archive::{exec_failure, quote};
use super::listing::{collect_local_tree, collect_remote_tree, parent_remote};
use super::session::{get_opener, get_session};
use super::{ChannelOpener, SftpClientState, TransferSummary};

/// A file's path relative to the top of what was transferred, and its digest.
///
/// Relative to the top rather than including it, so a directory that landed
/// under another name still compares against its source.
type Digests = Vec<(String, String)>;

/// Which side of a transfer a path is on.
pub enum Side<'a> {
    Local(&'a str),
    Remote { session_id: &'a str, path: &'a str },
}

/// Compares the two ends of a finished transfer.
///
/// Returns how many files matched. Any difference is an error naming the
/// first path that differs, since that is the one the user has to look at.
pub async fn verify_landing(
    sftp_state: &SftpClientState,
    source: Side<'_>,
    landed: Side<'_>,
) -> Result<u32> {
    let sent = digests(sftp_state, source).await?;
    let arrived = digests(sftp_state, landed).await?;
    compare(&sent, &arrived)
}

/// What one file, or one path in a comparison, is called and how big it is.
type Sizes = Vec<(String, u64)>;

/// How two directories differ.
///
/// Paths are relative to each side's root, so the two roots can be called
/// anything and live on different machines.
#[derive(Debug, Clone, Default, Serialize)]
pub struct TreeDiff {
    pub only_left: Vec<String>,
    pub only_right: Vec<String>,
    /// Same path on both sides, different content.
    pub differing: Vec<String>,
    /// Files the same on both sides.
    pub same: u32,
    /// True when the user stopped it, in which case the lists are partial.
    pub cancelled: bool,
    /// Files whose sizes matched and so had to be read and hashed.
    pub hashed: u32,
}

/// Compares two directories without copying anything.
///
/// Size first: a pair of different sizes is different, and a path on one side
/// only is missing, neither of which needs a byte read. Only the pairs whose
/// sizes match are hashed, which is the one case a cheap check cannot settle.
pub async fn compare_trees(
    sftp_state: &SftpClientState,
    // The same id a transfer would carry, so the panel's cancel reaches this
    // through the machinery it already has.
    transfer_id: &str,
    left: Side<'_>,
    right: Side<'_>,
) -> Result<TreeDiff> {
    let guard = sftp_state.begin_transfer(transfer_id);
    let cancel = &*guard.cancel;
    let left_sizes = sizes(sftp_state, &left).await?;
    let right_sizes = sizes(sftp_state, &right).await?;

    let right_by_path: HashMap<&str, u64> =
        right_sizes.iter().map(|(rel, size)| (rel.as_str(), *size)).collect();
    let left_paths: HashMap<&str, u64> =
        left_sizes.iter().map(|(rel, size)| (rel.as_str(), *size)).collect();

    let mut diff = TreeDiff::default();
    let mut candidates: Vec<String> = Vec::new();
    for (rel, size) in &left_sizes {
        match right_by_path.get(rel.as_str()) {
            None => diff.only_left.push(rel.clone()),
            Some(other) if other != size => diff.differing.push(rel.clone()),
            Some(_) => candidates.push(rel.clone()),
        }
    }
    for (rel, _) in &right_sizes {
        if !left_paths.contains_key(rel.as_str()) {
            diff.only_right.push(rel.clone());
        }
    }

    if cancel.load(Ordering::Relaxed) {
        diff.cancelled = true;
        return Ok(sorted(diff));
    }

    if !candidates.is_empty() {
        diff.hashed = candidates.len() as u32;
        let left_digests = digests_of(sftp_state, &left, &candidates, cancel).await?;
        if cancel.load(Ordering::Relaxed) {
            diff.cancelled = true;
            return Ok(sorted(diff));
        }
        let right_digests = digests_of(sftp_state, &right, &candidates, cancel).await?;
        for rel in &candidates {
            match (left_digests.get(rel), right_digests.get(rel)) {
                (Some(a), Some(b)) if a == b => diff.same += 1,
                // A file that vanished between the walk and the hash is as
                // good as different; saying so beats saying nothing.
                _ => diff.differing.push(rel.clone()),
            }
        }
        diff.cancelled = cancel.load(Ordering::Relaxed);
    }
    Ok(sorted(diff))
}

fn sorted(mut diff: TreeDiff) -> TreeDiff {
    diff.only_left.sort();
    diff.only_right.sort();
    diff.differing.sort();
    diff
}

/// Every regular file under a side, by path relative to it, with its size.
async fn sizes(sftp_state: &SftpClientState, side: &Side<'_>) -> Result<Sizes> {
    match side {
        Side::Local(path) => {
            let root = PathBuf::from(*path);
            tokio::task::spawn_blocking(move || {
                if root.is_file() {
                    let size = std::fs::metadata(&root)?.len();
                    return Ok(vec![(String::new(), size)]);
                }
                let (items, _skipped) = collect_local_tree(&root)?;
                Ok(items.into_iter().filter(|i| !i.is_dir).map(|i| (i.rel, i.size)).collect())
            })
            .await
            .map_err(|e| anyhow!("The walk stopped: {e}"))?
        }
        Side::Remote { session_id, path } => {
            let sftp = get_session(sftp_state, session_id).await?;
            {
                let guard = sftp.lock().await;
                let meta = guard.metadata(*path).await.with_context(|| path.to_string())?;
                if !meta.file_type().is_dir() {
                    return Ok(vec![(String::new(), meta.size.unwrap_or(0))]);
                }
            }
            let (items, _skipped) = collect_remote_tree(&sftp, path).await?;
            Ok(items.into_iter().filter(|i| !i.is_dir).map(|i| (i.rel, i.size)).collect())
        }
    }
}

/// Hashes only the paths asked for, relative to the side's root.
async fn digests_of(
    sftp_state: &SftpClientState,
    side: &Side<'_>,
    rels: &[String],
    cancel: &AtomicBool,
) -> Result<HashMap<String, String>> {
    match side {
        Side::Local(path) => {
            let root = PathBuf::from(*path);
            let rels = rels.to_vec();
            let stop = cancel.load(Ordering::Relaxed);
            tokio::task::spawn_blocking(move || {
                let mut out = HashMap::new();
                if stop { return Ok(out); }
                for rel in rels {
                    let at = if rel.is_empty() { root.clone() } else { root.join(&rel) };
                    out.insert(rel, digest_file(&at)?);
                }
                Ok(out)
            })
            .await
            .map_err(|e| anyhow!("The checksum stopped: {e}"))?
        }
        Side::Remote { session_id, path } => {
            let opener = get_opener(sftp_state, session_id).await?;
            let mut out = HashMap::new();
            // One command per batch: an argument list of ten thousand paths
            // is past what a shell will take, and a batch still costs one
            // round trip rather than one per file.
            for chunk in rels.chunks(BATCH) {
                if cancel.load(Ordering::Relaxed) { break; }
                let digests = remote_digests_of(opener.as_ref(), path, chunk).await?;
                out.extend(digests);
            }
            Ok(out)
        }
    }
}

/// Paths per `sha256sum` command. Keeps the command line well inside any
/// shell's limit while still costing one round trip for many files.
const BATCH: usize = 200;

async fn remote_digests_of(
    opener: &dyn ChannelOpener,
    root: &str,
    rels: &[String],
) -> Result<HashMap<String, String>> {
    let mut args = String::new();
    for rel in rels {
        args.push(' ');
        args.push_str(&quote(&join_rel(root, rel)));
    }
    let command = format!("sha256sum --{args}");
    let out = run_capture(opener, &command).await?;

    let mut digests = HashMap::new();
    for line in out.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() { continue; }
        let Some((digest, path)) = line.split_once("  ") else {
            bail!("Could not read what sha256sum said: {line}");
        };
        let rel = path.strip_prefix(&format!("{root}/")).unwrap_or("").to_string();
        let rel = if path == root { String::new() } else { rel };
        digests.insert(rel, digest.to_string());
    }
    Ok(digests)
}

/// A path relative to a remote root, joined the way the far end spells it.
fn join_rel(root: &str, rel: &str) -> String {
    if rel.is_empty() { root.to_string() } else { format!("{}/{}", root.trim_end_matches('/'), rel) }
}

/// Runs a command on the far end and returns its stdout.
async fn run_capture(opener: &dyn ChannelOpener, command: &str) -> Result<String> {
    let mut channel = opener
        .open_session()
        .await
        .context("Could not open a channel for sha256sum")?;
    channel
        .exec(true, command)
        .await
        .context("The server refused to run sha256sum")?;

    let mut stdout = Vec::new();
    let mut stderr = String::new();
    let mut status = None;
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { ref data } => stdout.extend_from_slice(data),
            ChannelMsg::ExtendedData { ref data, .. } => stderr.push_str(&String::from_utf8_lossy(data)),
            ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
            // Not Eof: the exit status arrives after it, so breaking there
            // loses the reason the command failed.
            ChannelMsg::Close => break,
            _ => {}
        }
    }
    let _ = channel.close().await;
    if let Some(e) = exec_failure("sha256sum on the server", "sha256sum", status, &stderr) {
        return Err(e);
    }
    Ok(String::from_utf8_lossy(&stdout).into_owned())
}

/// Whether a summary describes a transfer whose two trees should match.
pub fn comparable(summary: &TransferSummary) -> bool {
    !summary.cancelled
        && summary.skipped_existing == 0
        && summary.skipped_symlinks == 0
        && summary.renamed == 0
        && summary.landed.is_some()
}

async fn digests(sftp_state: &SftpClientState, side: Side<'_>) -> Result<Digests> {
    match side {
        Side::Local(path) => {
            let path = PathBuf::from(path);
            tokio::task::spawn_blocking(move || local_digests(&path))
                .await
                .map_err(|e| anyhow!("The checksum stopped: {e}"))?
        }
        Side::Remote { session_id, path } => {
            let opener = get_opener(sftp_state, session_id).await?;
            remote_digests(opener.as_ref(), path).await
        }
    }
}

/// Every regular file under `root`, by path relative to it, with its digest.
///
/// A single file is one entry under the empty path, which is what lets a
/// file compare against a file and a directory against a directory without
/// the caller knowing which it has.
fn local_digests(root: &Path) -> Result<Digests> {
    let mut out = Digests::new();
    let meta = std::fs::symlink_metadata(root).with_context(|| root.display().to_string())?;
    if meta.is_file() {
        out.push((String::new(), digest_file(root)?));
        return Ok(out);
    }
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).with_context(|| dir.display().to_string())? {
            let entry = entry?;
            let path = entry.path();
            let meta = std::fs::symlink_metadata(&path)?;
            // Symlinks are not transferred, so they are not compared either.
            if meta.is_symlink() { continue; }
            if meta.is_dir() {
                stack.push(path);
            } else if meta.is_file() {
                let rel = path
                    .strip_prefix(root)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push((rel, digest_file(&path)?));
            }
        }
    }
    out.sort();
    Ok(out)
}

fn digest_file(path: &Path) -> Result<String> {
    let mut file = std::fs::File::open(path).with_context(|| path.display().to_string())?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 128 * 1024];
    loop {
        let read = file.read(&mut buf)?;
        if read == 0 { break; }
        hasher.update(&buf[..read]);
    }
    Ok(hex(&hasher.finalize()))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The command run on the far end: every file under the path, hashed.
///
/// `cd` into the parent and name the entry relatively, so the paths coming
/// back are relative to it and can have the entry's own name stripped. Both
/// words go through the same quoting `tar` uses, so a directory called
/// `don't` survives the shell.
pub(super) fn digest_command(remote_path: &str) -> String {
    let trimmed = remote_path.trim_end_matches('/');
    let name = trimmed.rsplit('/').next().unwrap_or(trimmed);
    let parent = parent_remote(trimmed);
    format!(
        "cd {} && find {} -type f -exec sha256sum -- {{}} +",
        quote(&parent),
        quote(name),
    )
}

async fn remote_digests(opener: &dyn ChannelOpener, remote_path: &str) -> Result<Digests> {
    let mut channel = opener
        .open_session()
        .await
        .context("Could not open a channel for sha256sum")?;
    channel
        .exec(true, digest_command(remote_path))
        .await
        .context("The server refused to run sha256sum")?;

    let mut stdout = Vec::new();
    let mut stderr = String::new();
    let mut status = None;
    while let Some(msg) = channel.wait().await {
        match msg {
            ChannelMsg::Data { ref data } => stdout.extend_from_slice(data),
            ChannelMsg::ExtendedData { ref data, .. } => stderr.push_str(&String::from_utf8_lossy(data)),
            ChannelMsg::ExitStatus { exit_status } => status = Some(exit_status),
            // Not Eof: the exit status arrives after it, so breaking there
            // loses the reason the command failed.
            ChannelMsg::Close => break,
            _ => {}
        }
    }
    let _ = channel.close().await;
    if let Some(e) = exec_failure("sha256sum on the server", "sha256sum", status, &stderr) {
        return Err(e);
    }

    let name = remote_path.trim_end_matches('/').rsplit('/').next().unwrap_or(remote_path);
    parse_digests(&String::from_utf8_lossy(&stdout), name)
}

/// Reads `sha256sum` output into digests relative to `name`.
///
/// The coreutils format is the digest, two spaces, then the path as it was
/// given, which here is `name` or something under it.
pub(super) fn parse_digests(out: &str, name: &str) -> Result<Digests> {
    let mut digests = Digests::new();
    for line in out.lines() {
        let line = line.trim_end_matches('\r');
        if line.is_empty() { continue; }
        let Some((digest, path)) = line.split_once("  ") else {
            bail!("Could not read what sha256sum said: {line}");
        };
        let path = path.strip_prefix("./").unwrap_or(path);
        let rel = if path == name {
            String::new()
        } else {
            path.strip_prefix(&format!("{name}/")).unwrap_or(path).to_string()
        };
        digests.push((rel, digest.to_string()));
    }
    digests.sort();
    Ok(digests)
}

/// How many files matched, or the first one that did not.
pub(super) fn compare(sent: &Digests, arrived: &Digests) -> Result<u32> {
    for (rel, digest) in sent {
        let here = arrived.iter().find(|(r, _)| r == rel);
        match here {
            None => bail!("{} did not arrive.", shown(rel)),
            Some((_, other)) if other != digest => {
                bail!("{} arrived different from the original.", shown(rel))
            }
            Some(_) => {}
        }
    }
    if arrived.len() > sent.len() {
        let extra = arrived.iter().find(|(r, _)| !sent.iter().any(|(s, _)| s == r));
        if let Some((rel, _)) = extra {
            bail!("{} is at the destination but was not sent.", shown(rel));
        }
    }
    Ok(sent.len() as u32)
}

/// A relative path as the message should read it; the empty one is the
/// transferred file itself.
fn shown(rel: &str) -> &str {
    if rel.is_empty() { "The file" } else { rel }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn d(pairs: &[(&str, &str)]) -> Digests {
        pairs.iter().map(|(r, h)| (r.to_string(), h.to_string())).collect()
    }

    #[test]
    fn the_command_survives_a_name_the_shell_would_eat() {
        assert_eq!(
            digest_command("/tmp/it's here/a b"),
            "cd '/tmp/it'\\''s here' && find 'a b' -type f -exec sha256sum -- {} +"
        );
    }

    #[test]
    fn output_is_read_relative_to_what_was_transferred() {
        let out = "aa  tree/one.txt\nbb  tree/sub/two.txt\n";
        assert_eq!(
            parse_digests(out, "tree").unwrap(),
            d(&[("one.txt", "aa"), ("sub/two.txt", "bb")])
        );
        // A single file is the empty path, so a file compares against a file.
        assert_eq!(parse_digests("cc  notes.txt\n", "notes.txt").unwrap(), d(&[("", "cc")]));
    }

    #[test]
    fn a_line_in_no_known_format_is_refused_rather_than_guessed_at() {
        assert!(parse_digests("sha256sum: tree: Permission denied", "tree").is_err());
    }

    #[test]
    fn equal_trees_count_their_files() {
        let one = d(&[("a", "11"), ("b", "22")]);
        assert_eq!(compare(&one, &one.clone()).unwrap(), 2);
    }

    #[test]
    fn a_difference_names_the_file_it_is_in() {
        let sent = d(&[("a", "11"), ("b", "22")]);
        let changed = d(&[("a", "11"), ("b", "99")]);
        let err = compare(&sent, &changed).unwrap_err().to_string();
        assert!(err.contains('b'), "{err}");

        let missing = d(&[("a", "11")]);
        assert!(compare(&sent, &missing).unwrap_err().to_string().contains('b'));

        let extra = d(&[("a", "11"), ("b", "22"), ("c", "33")]);
        assert!(compare(&sent, &extra).unwrap_err().to_string().contains('c'));
    }

    #[test]
    fn a_batch_names_each_path_under_the_root_it_is_relative_to() {
        assert_eq!(join_rel("/srv/tree", "sub/a.txt"), "/srv/tree/sub/a.txt");
        assert_eq!(join_rel("/srv/tree/", "a.txt"), "/srv/tree/a.txt");
        // The empty path is the transferred file itself.
        assert_eq!(join_rel("/srv/notes.txt", ""), "/srv/notes.txt");
    }

    #[test]
    fn a_transfer_that_left_the_trees_different_is_not_comparable() {
        let landed = || Some("/tmp/x".to_string());
        assert!(comparable(&TransferSummary { files: 1, landed: landed(), ..Default::default() }));
        assert!(!comparable(&TransferSummary { files: 1, landed: None, ..Default::default() }));
        assert!(!comparable(&TransferSummary { cancelled: true, landed: landed(), ..Default::default() }));
        assert!(!comparable(&TransferSummary { skipped_existing: 1, landed: landed(), ..Default::default() }));
        assert!(!comparable(&TransferSummary { skipped_symlinks: 1, landed: landed(), ..Default::default() }));
        assert!(!comparable(&TransferSummary { renamed: 1, landed: landed(), ..Default::default() }));
    }
}
