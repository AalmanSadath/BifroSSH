use tauri::{AppHandle, State};

use crate::models::AuthMethod;


use super::{CmdResult, connect_security, AppState};
use super::resolve::{JumpHopRequest, server_target};

// ── OS detection ─────────────────────────────────────────────────────────────

fn map_distro_id(id: &str) -> &'static str {
    match id {
        "ubuntu"                                       => "ubuntu",
        "debian"                                       => "debian",
        "fedora"                                       => "fedora",
        "arch" | "manjaro" | "endeavouros" | "garuda"  => "arch",
        "raspbian" | "raspios"                         => "raspberrypi",
        "freebsd"                                      => "freebsd",
        _                                              => "linux",
    }
}

/// Whether the output came from a Windows shell rather than a POSIX one.
///
/// The command sent is a POSIX line. On cmd.exe every word of it fails and
/// `|| ver` at the end prints the Windows version; on PowerShell the failure
/// text is different and `ver` may not run at all. Either sign is enough,
/// and both are checked because which one arrives depends on the default
/// shell the server was set up with.
fn is_windows_shell(output: &str) -> bool {
    let lower = output.to_lowercase();
    lower.contains("microsoft windows")
        || lower.contains("is not recognized as an internal or external command")
        || lower.contains("is not recognized as the name of a cmdlet")
}

fn parse_os_release(output: &str) -> String {
    let mut id = String::new();
    let mut name = String::new();
    let mut pretty_name = String::new();

    for line in output.lines() {
        let line = line.trim();
        if let Some(v) = line.strip_prefix("ID=")          { id          = v.trim_matches('"').to_lowercase(); }
        if let Some(v) = line.strip_prefix("NAME=")        { name        = v.trim_matches('"').to_lowercase(); }
        if let Some(v) = line.strip_prefix("PRETTY_NAME=") { pretty_name = v.trim_matches('"').to_lowercase(); }
    }

    // Raspberry Pi detection — hardware marker or name/pretty_name
    for line in output.lines() {
        let l = line.trim().to_lowercase();
        if l.contains("raspberry pi") { return "raspberrypi".to_string(); }
    }

    if !id.is_empty() {
        return map_distro_id(&id).to_string();
    }
    if name.contains("raspberry") || pretty_name.contains("raspberry") {
        return "raspberrypi".to_string();
    }

    // After the os-release checks, so a Linux host whose PRETTY_NAME happens
    // to mention Windows is still what its ID= says it is.
    if is_windows_shell(output) {
        return "windows".to_string();
    }

    // Fallback: uname -s
    for line in output.lines().rev() {
        match line.trim().to_lowercase().as_str() {
            "darwin"  => return "macos".to_string(),
            "freebsd" => return "freebsd".to_string(),
            _         => {}
        }
    }
    "linux".to_string()
}

#[tauri::command]
pub async fn detect_server_os(
    state: State<'_, AppState>,
    app: AppHandle,
    server_id: String,
    username: String,
    auth_type: AuthMethod,
    auth_value: String,
    jumps: Option<Vec<JumpHopRequest>>,
) -> CmdResult<String> {
    let target = {
        let data = state.data.lock().await;
        server_target(&data, &state.key()?, &server_id, auth_type, &auth_value, jumps.as_deref())?
    };

    // Non-interactive: this runs in the background with no UI to prompt from,
    // so an unknown host key fails rather than silently trusting.
    let sec = connect_security(&state, &app, None, false).await;

    let result = crate::ssh::exec_ssh_command(
        &target.host, target.port, &username, target.auth,
        // `|| ver` is for Windows. In sh, uname succeeds and ver never runs;
        // in cmd.exe the line fails and ver prints the Windows version, which
        // is the one sign that lands on stdout whatever the shell.
        "cat /etc/os-release 2>/dev/null; cat /proc/device-tree/model 2>/dev/null; echo; uname -s || ver",
        sec,
        &target.jumps,
    )
    .await;

    // A host that could not be asked is recorded as unknown rather than left
    // as never-asked. Only success used to be written, so the empty string
    // survived and openSession, which detects when it sees one, tried again on
    // every single connect to a host already known not to answer.
    let detected = match &result {
        Ok(output) => parse_os_release(output),
        Err(_) => crate::models::UNKNOWN_OS.to_string(),
    };

    {
        let mut data = state.data.lock().await;
        if let Some(server) = data.servers.iter_mut().find(|s| s.id == server_id) {
            server.os = detected.clone();
        }
        state.save(&data)?;
    }

    // The failure is still a failure to the caller; what changed is that the
    // answer to "have we tried this host" is now on disk either way.
    result?;
    Ok(detected)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_distro_id_wins() {
        assert_eq!(parse_os_release("ID=fedora\nNAME=\"Fedora Linux\"\n\nLinux\n"), "fedora");
        assert_eq!(parse_os_release("ID=ubuntu\nID_LIKE=debian\n\nLinux\n"), "ubuntu");
        assert_eq!(parse_os_release("ID=nixos\n\nLinux\n"), "linux");
    }

    #[test]
    fn a_raspberry_pi_is_known_by_its_hardware_line() {
        assert_eq!(parse_os_release("ID=debian\nRaspberry Pi 4 Model B\n\nLinux\n"), "raspberrypi");
    }

    #[test]
    fn uname_is_the_fallback_without_os_release() {
        assert_eq!(parse_os_release("\nDarwin\n"), "macos");
        assert_eq!(parse_os_release("\nFreeBSD\n"), "freebsd");
        assert_eq!(parse_os_release("\nLinux\n"), "linux");
    }

    /// cmd.exe as the default shell: the POSIX line fails as one command and
    /// `|| ver` runs. Whether the error text reaches stdout depends on the
    /// shell; the version line always does.
    #[test]
    fn a_windows_server_is_known_by_ver() {
        assert_eq!(parse_os_release("\nMicrosoft Windows [Version 10.0.19045.4651]\n"), "windows");
    }

    /// The failure text alone, for a shell where `ver` did not run.
    #[test]
    fn a_windows_server_is_known_by_the_shell_error() {
        assert_eq!(
            parse_os_release("'cat' is not recognized as an internal or external command,\noperable program or batch file.\n"),
            "windows",
        );
        assert_eq!(
            parse_os_release("cat : The term 'cat' is not recognized as the name of a cmdlet, function, script file, or operable program.\n"),
            "windows",
        );
    }

    /// A real os-release that mentions Windows in passing is still Linux.
    #[test]
    fn a_linux_host_mentioning_windows_stays_linux() {
        let out = "ID=ubuntu\nPRETTY_NAME=\"Ubuntu 24.04 on Microsoft Windows Subsystem for Linux\"\n\nLinux\n";
        assert_eq!(parse_os_release(out), "ubuntu");
    }
}
