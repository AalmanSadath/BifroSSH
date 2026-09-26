//! A shell on this machine, in a tab beside the SSH ones.
//!
//! It registers in the same sessions map and speaks the same events as an
//! SSH session, `ssh-output:{id}` out and `ssh-closed:{id}` at the end, so
//! the terminal, input, resize, logging and recording all work unchanged.
//! The PTY is `portable-pty`'s: a Unix pty, or ConPTY on Windows.

use std::io::{Read, Write};
use std::sync::Arc;

use anyhow::{anyhow, Context, Result};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::{interval, Duration};

use crate::ssh::{Attach, CloseReason, ClosedEvent, SessionOutput, SshCommand, SshSessionHandle, SshState};

/// What to run: a program and its arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellCommand {
    pub program: String,
    pub args: Vec<String>,
}

/// Where the shell is being started from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Platform {
    Unix,
    /// A Unix build inside a Flatpak sandbox, which holds none of the
    /// user's tools; the shell is started on the host instead.
    Flatpak,
    Windows,
}

/// Asks the host for the user's login shell, since `$SHELL` in the sandbox
/// is the sandbox's. `sh -l` if the account has none recorded.
const FLATPAK_LOGIN_SHELL: &str =
    r#"s=$(getent passwd "$(id -un)" | cut -d: -f7); exec "${s:-/bin/sh}" -l"#;

/// The command a local shell tab runs.
///
/// A non-blank `setting` wins, split as a shell would split it. Otherwise:
/// on Unix the login shell, from `$SHELL` or else the account's record; in a
/// Flatpak the same, but asked of and run on the host through
/// `flatpak-spawn`; on Windows PowerShell 7 if it is installed, then Windows
/// PowerShell. `login_shell` is the account's shell, and `has_pwsh` says
/// whether `pwsh.exe` is on the PATH; both are looked up by the caller so
/// this stays testable.
pub fn shell_command(
    platform: Platform,
    setting: &str,
    shell_env: Option<&str>,
    login_shell: Option<&str>,
    has_pwsh: bool,
) -> Result<ShellCommand> {
    if !setting.trim().is_empty() {
        let mut words = shell_words::split(setting.trim())
            .map_err(|e| anyhow!("The local shell setting could not be read: {e}"))?;
        let program = words.remove(0);
        return Ok(match platform {
            Platform::Flatpak => flatpak_spawn(program, words),
            _ => ShellCommand { program, args: words },
        });
    }
    Ok(match platform {
        Platform::Unix => {
            let shell = [shell_env, login_shell]
                .into_iter()
                .flatten()
                .find(|s| !s.trim().is_empty())
                .unwrap_or("/bin/sh");
            ShellCommand { program: shell.to_string(), args: vec!["-l".into()] }
        }
        Platform::Flatpak => flatpak_spawn("sh".into(), vec!["-c".into(), FLATPAK_LOGIN_SHELL.into()]),
        Platform::Windows => ShellCommand {
            program: if has_pwsh { "pwsh.exe" } else { "powershell.exe" }.into(),
            args: vec!["-NoLogo".into()],
        },
    })
}

/// `program args…` run on the host rather than in the sandbox. The terminal
/// variables are passed on, since the host's environment is not ours.
fn flatpak_spawn(program: String, args: Vec<String>) -> ShellCommand {
    let mut all = vec![
        "--host".to_string(),
        "--watch-bus".into(),
        "--env=TERM=xterm-256color".into(),
        "--env=COLORTERM=truecolor".into(),
        program,
    ];
    all.extend(args);
    ShellCommand { program: "flatpak-spawn".into(), args: all }
}

fn platform() -> Platform {
    if cfg!(windows) {
        Platform::Windows
    } else if std::path::Path::new("/.flatpak-info").exists() {
        Platform::Flatpak
    } else {
        Platform::Unix
    }
}

/// The account's shell from the password database.
#[cfg(unix)]
fn account_shell() -> Option<String> {
    // SAFETY: getpwuid returns a pointer into static storage or null; it is
    // read at once and copied out, on a thread that calls no other getpw*.
    unsafe {
        let pw = libc::getpwuid(libc::getuid());
        if pw.is_null() || (*pw).pw_shell.is_null() {
            return None;
        }
        Some(std::ffi::CStr::from_ptr((*pw).pw_shell).to_string_lossy().into_owned())
    }
}

#[cfg(not(unix))]
fn account_shell() -> Option<String> {
    None
}

fn on_path(program: &str) -> bool {
    std::env::var_os("PATH")
        .is_some_and(|paths| std::env::split_paths(&paths).any(|dir| dir.join(program).is_file()))
}

/// Starts a local shell and its session loop, and returns the session id.
pub async fn start(
    app: AppHandle,
    ssh_state: Arc<SshState>,
    setting: &str,
    cols: u16,
    rows: u16,
) -> Result<String> {
    let command = shell_command(
        platform(),
        setting,
        std::env::var("SHELL").ok().as_deref(),
        account_shell().as_deref(),
        cfg!(windows) && on_path("pwsh.exe"),
    )?;

    let pair = native_pty_system()
        .openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
        .context("Could not open a terminal for the local shell")?;
    let mut builder = CommandBuilder::new(&command.program);
    builder.args(&command.args);
    builder.env("TERM", "xterm-256color");
    builder.env("COLORTERM", "truecolor");
    // flatpak-spawn is only a relay: the host's session helper makes the
    // terminal the shell's controlling terminal, and the kernel refuses
    // that while flatpak-spawn's session already holds it, leaving the
    // shell with no job control.
    builder.set_controlling_tty(command.program != "flatpak-spawn");
    if let Some(home) = dirs::home_dir() {
        builder.cwd(home);
    }
    let mut child = pair
        .slave
        .spawn_command(builder)
        .with_context(|| format!("Could not start {}", command.program))?;
    // The shell holds the other end now. Keeping ours open would keep the
    // reader from ever seeing the end once the shell exits.
    drop(pair.slave);
    let master = pair.master;
    let mut reader = master.try_clone_reader().context("Could not read the local shell")?;
    let mut writer = master.take_writer().context("Could not write to the local shell")?;
    let mut killer = child.clone_killer();

    // Reading and writing a PTY block, so each has a thread of its own
    // rather than holding up the runtime: a big paste into a shell that is
    // busy would otherwise stall every other session.
    let (out_tx, mut out_rx) = mpsc::channel::<Vec<u8>>(64);
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if out_tx.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });
    let (in_tx, in_rx) = std::sync::mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        for data in in_rx {
            if writer.write_all(&data).and_then(|_| writer.flush()).is_err() {
                break;
            }
        }
    });
    // ConPTY does not end the output when the shell exits, only when the
    // pseudoconsole is closed, so the exit is watched for on its own.
    let (exit_tx, mut exit_rx) = oneshot::channel::<()>();
    std::thread::spawn(move || {
        let _ = child.wait();
        let _ = exit_tx.send(());
    });

    let session_id = uuid::Uuid::new_v4().to_string();
    let (cmd_tx, mut cmd_rx) = mpsc::channel::<SshCommand>(256);
    let attach = Arc::new(Mutex::new(Attach::default()));
    ssh_state.sessions.lock().await.insert(
        session_id.clone(),
        SshSessionHandle { cmd_tx, attach: Arc::clone(&attach), opener: None },
    );

    let sid = session_id.clone();
    tokio::spawn(async move {
        let mut out = SessionOutput::new(app.clone(), sid.clone(), attach, None);
        let mut flush_tick = interval(Duration::from_millis(8));
        flush_tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut closed_by_user = false;
        let mut master = Some(master);

        loop {
            tokio::select! {
                Some(cmd) = cmd_rx.recv() => match cmd {
                    SshCommand::Data(data) => {
                        let _ = in_tx.send(data);
                    }
                    SshCommand::Resize { cols, rows } => {
                        if let Some(m) = master.as_ref() {
                            let _ = m.resize(PtySize {
                                rows: rows.min(u16::MAX as u32) as u16,
                                cols: cols.min(u16::MAX as u32) as u16,
                                pixel_width: 0,
                                pixel_height: 0,
                            });
                        }
                        out.resized(cols, rows);
                    }
                    SshCommand::SetLog(file) => out.log = file,
                    SshCommand::SetRecording(next) => {
                        out.flush().await;
                        out.recorder = next;
                    }
                    SshCommand::Close => {
                        closed_by_user = true;
                        let _ = killer.kill();
                        break;
                    }
                },
                Some(data) = out_rx.recv() => {
                    let was_empty = out.buf.is_empty();
                    out.buf.extend_from_slice(&data);
                    if was_empty || out.buf.len() >= 8192 {
                        out.flush().await;
                    }
                }
                _ = &mut exit_rx => {
                    // What the shell printed on its way out is still in the
                    // pipe. Closing the PTY lets the reader reach the end of
                    // it on every platform; a moment is allowed for that.
                    drop(master.take());
                    let deadline = tokio::time::sleep(Duration::from_millis(300));
                    tokio::pin!(deadline);
                    loop {
                        tokio::select! {
                            more = out_rx.recv() => match more {
                                Some(data) => out.buf.extend_from_slice(&data),
                                None => break,
                            },
                            _ = &mut deadline => break,
                        }
                    }
                    break;
                }
                _ = flush_tick.tick() => out.flush().await,
            }
        }
        out.flush().await;
        drop(master);
        ssh_state.sessions.lock().await.remove(&sid);
        let reason = if closed_by_user { CloseReason::Closed } else { CloseReason::Exited };
        let _ = app.emit(&format!("ssh-closed:{sid}"), ClosedEvent { reason });
    });

    Ok(session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cmd(program: &str, args: &[&str]) -> ShellCommand {
        ShellCommand { program: program.into(), args: args.iter().map(|a| a.to_string()).collect() }
    }

    #[test]
    fn unix_runs_the_login_shell() {
        let run = |env, account| shell_command(Platform::Unix, "", env, account, false).unwrap();
        assert_eq!(run(Some("/bin/zsh"), Some("/bin/bash")), cmd("/bin/zsh", &["-l"]));
        assert_eq!(run(None, Some("/bin/bash")), cmd("/bin/bash", &["-l"]));
        assert_eq!(run(Some(""), None), cmd("/bin/sh", &["-l"]));
    }

    #[test]
    fn windows_prefers_powershell_7() {
        assert_eq!(shell_command(Platform::Windows, "", None, None, true).unwrap(), cmd("pwsh.exe", &["-NoLogo"]));
        assert_eq!(shell_command(Platform::Windows, " ", None, None, false).unwrap(), cmd("powershell.exe", &["-NoLogo"]));
    }

    /// The sandbox's own shell has none of the user's tools, so the host's
    /// is found and run on the host.
    #[test]
    fn a_flatpak_runs_the_shell_on_the_host() {
        let c = shell_command(Platform::Flatpak, "", Some("/bin/sh"), None, false).unwrap();
        assert_eq!(c.program, "flatpak-spawn");
        assert_eq!(&c.args[..2], ["--host", "--watch-bus"]);
        assert_eq!(&c.args[4..], ["sh", "-c", FLATPAK_LOGIN_SHELL]);
    }

    #[test]
    fn the_setting_wins_and_is_split_like_a_shell_line() {
        let c = shell_command(Platform::Unix, "fish --login -C 'echo hi'", Some("/bin/bash"), None, false).unwrap();
        assert_eq!(c, cmd("fish", &["--login", "-C", "echo hi"]));
        let c = shell_command(Platform::Flatpak, "fish", None, None, false).unwrap();
        assert_eq!(c.args.last().map(String::as_str), Some("fish"));
        assert!(shell_command(Platform::Unix, "fish 'unclosed", None, None, false).is_err());
    }
}
