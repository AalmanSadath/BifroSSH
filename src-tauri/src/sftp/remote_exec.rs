//! Running a command on the far end of a session.
//!
//! SFTP moves bytes; everything else a transfer needs from a server is a
//! shell command over a second channel: `tar` for a compressed copy,
//! `sha256sum` for verification, `head` for the beginning of an unfinished
//! file. The quoting, the reading and the failure message are the same
//! whichever of them is being run, so they live here rather than in
//! whichever module happened to need them first.

use anyhow::{anyhow, Context, Result};
use russh::ChannelMsg;

use super::ChannelOpener;

/// A path or a name as a single shell word.
///
/// The command is one string handed to the server's shell, so a directory
/// called `a b` or `don't` has to survive it. Single quotes take
/// everything literally; the only character that needs care is the quote
/// itself, which is closed, escaped and reopened.
pub(super) fn quote(word: &str) -> String {
    format!("'{}'", word.replace('\'', r"'\''"))
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

/// Runs a command on the far end and returns its stdout.
pub(crate) async fn run_capture(
    opener: &dyn ChannelOpener,
    tool: &str,
    command: &str,
) -> Result<String> {
    let mut channel = opener
        .open_session()
        .await
        .with_context(|| format!("Could not open a channel for {tool}"))?;
    channel
        .exec(true, command)
        .await
        .with_context(|| format!("The server refused to run {tool}"))?;

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
    if let Some(e) = exec_failure(&format!("{tool} on the server"), tool, status, &stderr) {
        return Err(e);
    }
    Ok(String::from_utf8_lossy(&stdout).into_owned())
}

/// Reads what is left of an exec channel: its stderr and its exit status.
pub(super) async fn drain_exec(channel: &mut russh::Channel<russh::client::Msg>) -> (Option<u32>, String) {
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

/// The command that hashes the given paths, each one quoted, with `--` so a
/// path that starts with a dash is still a path.
pub(super) fn sha256sum_command<'a>(paths: impl IntoIterator<Item = &'a str>) -> String {
    let mut command = String::from("sha256sum --");
    for path in paths {
        command.push(' ');
        command.push_str(&quote(path));
    }
    command
}

/// What `sha256sum` said, one line at a time: the path it was given, and the
/// digest of it.
///
/// The coreutils format is the digest, two spaces, then the path exactly as
/// it was asked about, so what a path means is the caller's business: one
/// caller wants it relative to a transfer root, one relative to a directory
/// it cd'd into, and one wants it as given. Blank lines are skipped; a line
/// in any other shape is the error, because a server that answers something
/// else has not run the command that was asked for.
pub(super) fn digest_lines(out: &str) -> impl Iterator<Item = Result<(&str, &str)>> {
    out.lines().filter_map(|line| {
        let line = line.trim_end_matches('\r');
        if line.is_empty() {
            return None;
        }
        Some(match line.split_once("  ") {
            Some((digest, path)) => Ok((path, digest)),
            None => Err(anyhow!("Could not read what sha256sum said: {line}")),
        })
    })
}
