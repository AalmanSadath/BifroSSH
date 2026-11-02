//! What the app was opened for from outside: an `ssh://` link, a host from
//! the taskbar's jump list or the launcher, or (on Android) shared text.
//!
//! Android keeps the launch in MainActivity until the page asks for it. On
//! the desktop it arrives as a command line, either this process's own or
//! one handed over by a second launch through the single-instance plugin,
//! and waits here instead. Either way the page takes it once it is unlocked
//! and loaded, since every kind needs the saved hosts.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Launch {
    Host { id: String },
    Ssh { url: String },
    Share { text: String },
}

/// The flag the jump list's entries pass, followed by a host id.
#[cfg_attr(target_os = "android", allow(dead_code))]
pub const HOST_FLAG: &str = "--host";

/// Reads a launch out of a command line, program name first.
///
/// Anything else on the line is ignored rather than refused: a desktop
/// environment may add arguments of its own, and the app opening normally
/// is the right answer to a line it does not understand.
#[cfg_attr(target_os = "android", allow(dead_code))]
pub fn parse_args<I: IntoIterator<Item = String>>(args: I) -> Option<Launch> {
    let mut args = args.into_iter().skip(1);
    while let Some(arg) = args.next() {
        if arg == HOST_FLAG {
            return args.next().filter(|id| !id.is_empty()).map(|id| Launch::Host { id });
        }
        if arg.len() > 6 && arg.get(..6).is_some_and(|p| p.eq_ignore_ascii_case("ssh://")) {
            return Some(Launch::Ssh { url: arg });
        }
    }
    None
}

#[cfg(not(target_os = "android"))]
pub use desktop::*;

#[cfg(not(target_os = "android"))]
mod desktop {
    use super::{parse_args, Launch};
    use std::sync::Mutex;
    use tauri::{AppHandle, Emitter, Manager};

    /// The launch the page has not taken yet. Only the latest is kept: two
    /// links clicked while the vault is locked open the second.
    #[derive(Default)]
    pub struct PendingLaunch(Mutex<Option<Launch>>);

    impl PendingLaunch {
        pub fn from_args<I: IntoIterator<Item = String>>(args: I) -> Self {
            PendingLaunch(Mutex::new(parse_args(args)))
        }

        pub fn take(&self) -> Option<Launch> {
            self.0.lock().ok()?.take()
        }
    }

    /// A second launch, handed over by the single-instance plugin. The
    /// window it would have opened is this one, brought forward, and
    /// whatever it was opened for waits for the page.
    pub fn second_launch(app: &AppHandle, args: Vec<String>) {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
        let Some(launch) = parse_args(args) else { return };
        if let Ok(mut pending) = app.state::<PendingLaunch>().0.lock() {
            *pending = Some(launch);
        }
        let _ = app.emit_to("main", "launch", ());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        std::iter::once("bifrossh").chain(list.iter().copied()).map(String::from).collect()
    }

    #[test]
    fn a_plain_launch_is_none() {
        assert_eq!(parse_args(args(&[])), None);
    }

    #[test]
    fn an_ssh_link_is_kept_whole() {
        assert_eq!(
            parse_args(args(&["ssh://alice@example.com:2222"])),
            Some(Launch::Ssh { url: "ssh://alice@example.com:2222".into() })
        );
    }

    #[test]
    fn the_scheme_is_matched_without_regard_to_case() {
        assert!(matches!(parse_args(args(&["SSH://example.com"])), Some(Launch::Ssh { .. })));
    }

    #[test]
    fn a_host_from_the_jump_list() {
        assert_eq!(parse_args(args(&["--host", "abc-123"])), Some(Launch::Host { id: "abc-123".into() }));
    }

    #[test]
    fn a_host_flag_with_nothing_after_it_is_ignored() {
        assert_eq!(parse_args(args(&["--host"])), None);
    }

    #[test]
    fn the_program_name_is_never_read_as_a_link() {
        assert_eq!(parse_args(vec!["ssh://not-an-argument".to_string()]), None);
    }

    #[test]
    fn other_arguments_are_passed_over() {
        assert!(matches!(parse_args(args(&["--something", "ssh://h"])), Some(Launch::Ssh { .. })));
    }
}
