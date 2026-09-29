//! OpenSSH's ProxyCommand: the connection is a program's stdin and stdout
//! rather than a TCP socket.
//!
//! This is how `cloudflared access ssh`, AWS SSM, `nc -X` through a SOCKS or
//! HTTP proxy and the like reach a host. The program runs on this computer,
//! and the SSH handshake runs over its pipes exactly as it would over TCP.
//! In the Flatpak it runs on the host, where tools like those are installed.

use std::pin::Pin;
use std::sync::Arc;
use std::process::Stdio;
use std::task::{Context, Poll};

use anyhow::{anyhow, bail, Result};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, BufReader, ReadBuf};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};

use crate::connect::ConnectSecurity;
use crate::localshell::Platform;

/// Lines of the program's stderr copied into the connection log. Enough to
/// show why it failed; a chatty proxy that logs every packet does not get to
/// fill the log.
const STDERR_LINES: usize = 50;

/// A host's ProxyCommand as saved, with what its tokens stand for. Filled
/// in only when it is dialled, so a bad token fails inside the connect and
/// is told in its log like any other failure.
#[derive(Debug, Clone, PartialEq)]
pub struct ProxyCommand {
    pub command: String,
    pub host: String,
    pub port: u16,
    pub user: String,
}

impl ProxyCommand {
    pub fn expanded(&self) -> Result<String> {
        expand(&self.command, &self.host, self.port, &self.user)
    }
}

/// Fills in the `%` tokens OpenSSH knows for a ProxyCommand: `%h` host, `%p`
/// port, `%r` user, `%n` the host as given (the same thing here, with no
/// aliases), and `%%` a percent sign.
pub fn expand(command: &str, host: &str, port: u16, user: &str) -> Result<String> {
    let mut out = String::with_capacity(command.len());
    let mut chars = command.chars();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('h') | Some('n') => out.push_str(host),
            Some('p') => out.push_str(&port.to_string()),
            Some('r') => out.push_str(user),
            Some('%') => out.push('%'),
            Some(other) => bail!("The proxy command has %{other}, which is not one of %h, %p, %r, %n or %%"),
            None => bail!("The proxy command ends in a lone %"),
        }
    }
    Ok(out)
}

/// The program and arguments that run `command` the way OpenSSH would: through
/// the shell, with `exec` so the shell does not stay around in between.
pub fn command_line(platform: Platform, command: &str) -> (String, Vec<String>) {
    let shell = |program: &str| vec![program.to_string(), "-c".into(), format!("exec {command}")];
    match platform {
        Platform::Unix => {
            let mut args = shell("sh");
            ("sh".into(), args.split_off(1))
        }
        Platform::Flatpak => {
            let mut args = vec!["--host".to_string(), "--watch-bus".into()];
            args.extend(shell("sh"));
            ("flatpak-spawn".into(), args)
        }
        // cmd takes the rest of its line as it is; see `spawn`.
        Platform::Windows => ("cmd".into(), vec!["/C".into(), command.to_string()]),
    }
}

/// The running program, read and written as the transport.
pub struct ProxyStream {
    /// Held so the program lives as long as the stream: signalled in `Drop`
    /// on Unix, killed by `kill_on_drop` on Windows.
    #[cfg_attr(windows, allow(dead_code))]
    child: Child,
    stdout: ChildStdout,
    stdin: ChildStdin,
}

/// Starts the proxy command. Its stderr goes to the connection log, which is
/// where a proxy explains why it could not reach anything.
pub fn spawn(command: &str, sec: &ConnectSecurity) -> Result<ProxyStream> {
    let sec = sec.clone();
    spawn_on(crate::localshell::platform(), command, Arc::new(move |kind, line| sec.log(kind, line)))
}

/// Where a proxy's narration goes: the kind of line, and the line.
type Log = Arc<dyn Fn(&str, &str) + Send + Sync>;

fn spawn_on(platform: Platform, command: &str, log: Log) -> Result<ProxyStream> {
    log("network", &format!("Running proxy command: {command}"));
    let (program, args) = command_line(platform, command);
    let mut cmd = Command::new(&program);
    #[cfg(windows)]
    {
        // cmd has its own quoting rules, which the usual argument escaping
        // would mangle; the command goes over as typed.
        cmd.arg(&args[0]).raw_arg(&args[1]);
        // No console window flashing up for the length of the connection.
        cmd.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    cmd.args(&args);
    // SIGKILL on Windows, where there is nothing gentler. On Unix `Drop`
    // sends SIGTERM instead, which flatpak-spawn passes on to the program on
    // the host and a SIGKILL would not.
    cmd.kill_on_drop(cfg!(windows))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| anyhow!("Could not run the proxy command ({program}: {e})"))?;

    let stdout = child.stdout.take().ok_or_else(|| anyhow!("The proxy command has no stdout"))?;
    let stdin = child.stdin.take().ok_or_else(|| anyhow!("The proxy command has no stdin"))?;
    if let Some(stderr) = child.stderr.take() {
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            let mut shown = 0;
            while let Ok(Some(line)) = lines.next_line().await {
                if shown < STDERR_LINES && !line.trim().is_empty() {
                    log("error", &format!("proxy: {line}"));
                    shown += 1;
                }
            }
        });
    }
    Ok(ProxyStream { child, stdout, stdin })
}

impl Drop for ProxyStream {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.child.id() {
            // SAFETY: kill(2) with a pid this process started and has not
            // yet reaped; the worst case is a signal to a process that has
            // already exited, which is refused with ESRCH.
            unsafe { libc::kill(pid as libc::pid_t, libc::SIGTERM) };
        }
    }
}

impl AsyncRead for ProxyStream {
    fn poll_read(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stdout).poll_read(cx, buf)
    }
}

impl AsyncWrite for ProxyStream {
    fn poll_write(mut self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut self.stdin).poll_write(cx, buf)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stdin).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut self.stdin).poll_shutdown(cx)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_are_filled_in() {
        assert_eq!(
            expand("nc -X 5 -x proxy:1080 %h %p", "db.internal", 2222, "alice").unwrap(),
            "nc -X 5 -x proxy:1080 db.internal 2222"
        );
        assert_eq!(expand("ssh -W %n:%p %r@bastion", "h", 22, "bob").unwrap(), "ssh -W h:22 bob@bastion");
        assert_eq!(expand("echo 100%%", "h", 22, "u").unwrap(), "echo 100%");
    }

    #[test]
    fn an_unknown_token_is_refused() {
        assert!(expand("connect %x", "h", 22, "u").unwrap_err().to_string().contains("%x"));
        assert!(expand("connect %", "h", 22, "u").is_err());
    }

    #[test]
    fn the_command_runs_through_the_shell_for_each_platform() {
        assert_eq!(
            command_line(Platform::Unix, "nc h 22"),
            ("sh".to_string(), vec!["-c".to_string(), "exec nc h 22".to_string()])
        );
        let (program, args) = command_line(Platform::Flatpak, "nc h 22");
        assert_eq!(program, "flatpak-spawn");
        assert_eq!(args, ["--host", "--watch-bus", "sh", "-c", "exec nc h 22"]);
        assert_eq!(
            command_line(Platform::Windows, "nc h 22"),
            ("cmd".to_string(), vec!["/C".to_string(), "nc h 22".to_string()])
        );
    }

    /// Bytes written go to the program and what it prints comes back: the
    /// transport contract, with `cat` standing in for a proxy.
    #[cfg(unix)]
    #[tokio::test]
    async fn the_stream_carries_bytes_both_ways_and_stderr_is_logged() {
        use std::sync::Mutex;
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let lines: Arc<Mutex<Vec<String>>> = Arc::default();
        let seen = Arc::clone(&lines);
        let log: Log = Arc::new(move |kind, line| seen.lock().unwrap().push(format!("{kind}: {line}")));
        let mut stream = spawn_on(Platform::Unix, "sh -c 'echo nope >&2; exec cat'", log).unwrap();
        stream.write_all(b"SSH-2.0-test\r\n").await.unwrap();
        let mut buf = [0u8; 14];
        stream.read_exact(&mut buf).await.unwrap();
        assert_eq!(&buf, b"SSH-2.0-test\r\n");
        drop(stream);
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        let lines = lines.lock().unwrap();
        assert!(lines[0].starts_with("network: Running proxy command"), "{lines:?}");
        assert!(lines.contains(&"error: proxy: nope".to_string()), "{lines:?}");
    }
}
