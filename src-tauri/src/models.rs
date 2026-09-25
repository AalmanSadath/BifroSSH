use serde::{Deserialize, Deserializer, Serialize};

/// Deserializes a field, falling back to its default rather than failing.
///
/// These enums used to be `String`, so nothing rejected a value outside the
/// set and the TypeScript unions describing them were a promise the compiler
/// then defended. Making them enums is the fix, but a plain enum turns one
/// hand-edited `"app_theme": "neon"` into a document that will not parse at
/// all, which costs the user every host they have saved to correct one
/// setting. This reads the value, keeps it if it is one of the variants, and
/// quietly takes the default if it is not.
///
/// The format is always JSON here, on disk and across the IPC bridge alike.
fn lenient<'de, D, T>(deserializer: D) -> Result<T, D::Error>
where
    D: Deserializer<'de>,
    T: Default + serde::de::DeserializeOwned,
{
    let value = serde_json::Value::deserialize(deserializer)?;
    Ok(T::deserialize(value).unwrap_or_default())
}

/// Auth modes that are not expressed by a stored credential.
///
/// `None` on a record means the credential fields decide, as before.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AuthKind {
    /// PAM/2FA challenge-response, answered per connection and never stored.
    KeyboardInteractive,
    /// Keys held by a running ssh-agent.
    Agent,
}

/// How a connection proves who it is.
///
/// Distinct from [`AuthKind`], which records what a saved host or identity is
/// configured to use; this is what the frontend picked for one connect, after
/// resolving an identity and its credentials. Unknown values were previously
/// treated as `Key`, so a misspelling arrived as "Key not found".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AuthMethod {
    /// `auth_value` is the id of a key in the keychain.
    Key,
    Password,
    KeyboardInteractive,
    /// `auth_value` optionally pins one agent key by fingerprint.
    Agent,
}

/// Which app palette is in force.
///
/// `System` is a choice about where the answer comes from rather than a
/// palette of its own: it resolves to Light or Dark from what the desktop
/// reports. Never to Amoled, which no desktop can ask for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppTheme {
    #[default]
    Dark,
    Light,
    Amoled,
    System,
}

/// What to do about a host key that is not already trusted.
///
/// A mismatched key is blocked under all three.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HostKeyPolicy {
    /// The choice that cannot silently trust something, so also the fallback.
    #[default]
    Ask,
    AcceptNew,
    Strict,
}

/// Shape of the terminal cursor. Passed straight to xterm.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CursorStyle {
    #[default]
    Block,
    Underline,
    Bar,
}

/// Which direction a port forwarding rule carries traffic.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PfKind {
    #[default]
    Local,
    Remote,
    Dynamic,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Server {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub identity_id: Option<String>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub encrypted_password: Option<String>,
    #[serde(default)]
    pub key_id: Option<String>,
    #[serde(default)]
    pub theme: Option<String>,
    /// Which OS the host runs, for its icon.
    ///
    /// Two sentinels, and the difference matters: empty means nobody has
    /// looked yet, and [`UNKNOWN_OS`] means somebody looked and could not
    /// tell. Without the second one, a host that cannot answer is asked again
    /// on every connect for as long as it exists.
    #[serde(default = "Server::default_os")]
    pub os: String,
    #[serde(default)]
    pub connection_timeout: Option<u32>,
    #[serde(default, deserialize_with = "lenient")]
    pub auth_kind: Option<AuthKind>,
    /// Id of another saved server to reach this one through, the equivalent of
    /// OpenSSH's ProxyJump. That server's own `proxy_jump` is followed too, so
    /// a chain of bastions is expressed one link at a time.
    #[serde(default)]
    pub proxy_jump: Option<String>,
    /// ssh's -A. While a session to this host is open, programs there can use
    /// the local agent's keys, and so can anyone with root there. Off unless
    /// the user turned it on for this host.
    #[serde(default)]
    pub forward_agent: bool,
    /// Every session to this host is written to a log file from its
    /// first byte. Off by default.
    #[serde(default)]
    pub log_sessions: bool,
    /// A name that hosts are sectioned by on the hosts page. Free text;
    /// `None` and the empty string both mean no group.
    #[serde(default)]
    pub group: Option<String>,
    /// One line sent to the shell as if typed, once the shell has finished
    /// saying hello.
    #[serde(default)]
    pub run_on_connect: Option<String>,
    /// Keep that line out of the terminal, by taking its echo back out of
    /// the output. On by default: the line is the app's typing rather than
    /// the user's, and a long one, like the shell integration snippet, is
    /// nothing but noise above the first prompt. Turned off for a command
    /// whose being typed is the point.
    #[serde(default = "Server::default_hide_run_on_connect")]
    pub hide_run_on_connect: bool,
    /// Whatever the user wants to remember about this host. Free text,
    /// searched with the rest of the record.
    #[serde(default)]
    pub notes: Option<String>,
    /// The terminal type asked for when the PTY is requested; None is
    /// `xterm-256color`. A host whose curses build predates that name needs
    /// `xterm`, and there is no way to tell it one from the far side.
    #[serde(default)]
    pub term: Option<String>,
    /// Variables to ask the server to set, one `NAME=value` per line, held as
    /// the text the user typed rather than as pairs: a round trip through the
    /// form then keeps their order, their spacing and their comments.
    #[serde(default)]
    pub env: Option<String>,
}

/// The variables in an [`Server::env`] block, in the order they were written.
///
/// Blank lines and `#` comments are skipped. A name is what a shell would
/// accept, letters, digits and underscore, not starting with a digit; a line
/// that is not one is dropped rather than sent, since the server would refuse
/// the request and the user would be told nothing. The value is kept exactly
/// as typed, trailing spaces included, because a value is data.
pub fn env_pairs(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter_map(|line| {
            let line = line.trim_start().trim_end_matches('\r');
            if line.is_empty() || line.starts_with('#') {
                return None;
            }
            let (name, value) = line.split_once('=')?;
            let name = name.trim_end();
            if !is_env_name(name) {
                return None;
            }
            Some((name.to_string(), value.to_string()))
        })
        .collect()
}

fn is_env_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with(|c: char| c.is_ascii_digit())
        && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// [`Server::term`] for a host that has not asked for another one.
pub const DEFAULT_TERM: &str = "xterm-256color";

impl Server {
    // Not a container-level default: `name`, `host` and `port` are required
    // on purpose, and a record missing one of them is a host that would list
    // fine and never connect. Better to say the document is wrong.
    fn default_os() -> String { UNDETECTED_OS.to_string() }
    fn default_hide_run_on_connect() -> bool { true }
}

/// [`Server::os`] for a host nobody has asked yet, which is what an absent
/// `os` deserializes to.
///
/// The frontend decides whether to run detection on this exact value, so the
/// two must agree: see `UNDETECTED_OS` in `types.ts`.
pub const UNDETECTED_OS: &str = "";

/// [`Server::os`] for a host that was asked and could not say.
///
/// The frontend compares against this exact string to pick a generic icon, so
/// it is part of the contract with `OsIcon`.
pub const UNKNOWN_OS: &str = "server";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Identity {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub username: String,
    #[serde(default)]
    pub key_id: Option<String>,
    #[serde(default)]
    pub encrypted_password: Option<String>,
    #[serde(default, deserialize_with = "lenient")]
    pub auth_kind: Option<AuthKind>,
    /// Pins one ssh-agent key by fingerprint; None tries every key it offers.
    #[serde(default)]
    pub agent_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyEntry {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub key_path: Option<String>,
    pub encrypted_key: Option<String>,
    pub encrypted_passphrase: Option<String>,
    #[serde(default)]
    pub algorithm: Option<String>,
}

/// Every field defaults, and the defaults are `Default::default()` rather
/// than a second copy of them written as attributes: the pair had drifted
/// into ten functions saying what `impl Default` already said, and four
/// fields with no default at all, which made a settings file missing any one
/// of them fail the whole document.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub theme: String,
    pub font_size: u16,
    pub font_family: String,
    #[serde(deserialize_with = "lenient")]
    pub cursor_style: CursorStyle,
    pub cursor_blink: bool,
    #[serde(deserialize_with = "lenient")]
    pub app_theme: AppTheme,
    pub connection_timeout_secs: u32,
    pub show_hover_hints: bool,
    pub sftp_inactivity_timeout_secs: u32,
    #[serde(deserialize_with = "lenient")]
    pub host_key_policy: HostKeyPolicy,
    /// `#rrggbb` the user picked, or None to follow the desktop's own accent
    /// and fall back to the palette's built-in one where there is none.
    ///
    /// Held as an override rather than seeded at first launch, so a desktop
    /// that changes its accent is still followed by everyone who never chose
    /// one of their own.
    pub accent_color: Option<String>,
    /// Seconds between keepalives on terminal and tunnel connections; 0 is off.
    /// Stops idle sessions being dropped by NAT and firewall idle timers, and
    /// makes a dead connection surface instead of hanging.
    ///
    /// Not applied to SFTP: those set an inactivity timeout to close idle
    /// sessions, and keepalive traffic would stop it ever firing.
    pub keepalive_interval_secs: u32,
    /// Minutes without input before the vault locks itself; 0 is off, and
    /// off is the default. Input means the user's, not a server's: output
    /// arriving in a terminal does not count.
    pub auto_lock_minutes: u32,
    /// Lock before the machine sleeps, so what is on screen after resume is
    /// the unlock screen. On by default.
    pub lock_on_suspend: bool,
    /// Lines a terminal keeps above the screen. Was a constant of the same
    /// value; a settings file from before this reads the same.
    pub scrollback_lines: u32,
    /// Where session logs are written; None is `<data dir>/logs`.
    pub session_log_dir: Option<String>,
    /// Ask GitHub once a day whether a newer release exists. On by default;
    /// the check is one anonymous GET of the releases endpoint.
    pub check_for_updates: bool,
    /// When the last check ran, epoch seconds; 0 for never.
    pub last_update_check: u64,
    /// Bring a dropped terminal back on its own, the way an autostart
    /// tunnel already does. On by default.
    pub auto_reconnect: bool,
    /// How many times before it gives up and leaves the button; 0 is
    /// until it comes back or the user says stop.
    pub auto_reconnect_attempts: u32,
    /// Open the tabs that were open when the app last closed, and connect
    /// them. On by default.
    pub restore_tabs: bool,
    /// Read both copies back after a transfer and compare them file by file.
    /// Off by default: it costs a full read of each side.
    pub verify_transfers: bool,
    /// Keyboard bindings the user changed, action id to comma-joined chords;
    /// an empty string unbinds. Sparse on purpose, so a default corrected in
    /// a later version still reaches everyone who never touched it. The
    /// frontend owns the table of actions and the chord spelling.
    pub shortcuts: std::collections::HashMap<String, String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: "bifrossh-dark".to_string(),
            font_size: 14,
            font_family: "monospace".to_string(),
            cursor_style: CursorStyle::Block,
            cursor_blink: true,
            app_theme: AppTheme::Dark,
            connection_timeout_secs: 60,
            show_hover_hints: true,
            sftp_inactivity_timeout_secs: 300,
            host_key_policy: HostKeyPolicy::Ask,
            accent_color: None,
            keepalive_interval_secs: 30,
            auto_lock_minutes: 0,
            lock_on_suspend: true,
            scrollback_lines: 10_000,
            session_log_dir: None,
            check_for_updates: true,
            last_update_check: 0,
            auto_reconnect: true,
            auto_reconnect_attempts: 5,
            restore_tabs: true,
            verify_transfers: false,
            shortcuts: std::collections::HashMap::new(),
        }
    }
}

/// A saved port forwarding rule.
///
/// Started by hand unless one of the autostart flags says otherwise. Both
/// default to off, which is what every rule saved before they existed gets.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortForwarding {
    pub id: String,
    pub label: String,
    #[serde(rename = "type", deserialize_with = "lenient")]
    pub kind: PfKind,
    pub bind_address: String,
    pub local_port: Option<u32>,
    pub intermediate_host_id: Option<String>,
    pub remote_host_id: Option<String>,
    pub remote_port: Option<u32>,
    pub dest_address: String,
    pub dest_port: Option<u32>,
    /// Start when the app opens or the vault unlocks.
    #[serde(default)]
    pub autostart_on_launch: bool,
    /// Start when a session opens to the rule's own host.
    #[serde(default)]
    pub autostart_on_connect: bool,
}

/// A named shell command the user can paste or run in any session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Codeprint {
    pub id: String,
    pub name: String,
    pub command: String,
}

/// A directory the user wants back in one click, on a host or on this
/// machine.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftpBookmark {
    pub id: String,
    /// The host it belongs to; `None` is the local pane, whose paths mean
    /// nothing on a server.
    #[serde(default)]
    pub server_id: Option<String>,
    pub label: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppData {
    pub servers: Vec<Server>,
    pub identities: Vec<Identity>,
    pub keys: Vec<KeyEntry>,
    // A document written before a field existed, or hand-edited without one,
    // keeps every other record it holds rather than failing as a whole.
    #[serde(default)]
    pub settings: Settings,
    #[serde(default)]
    pub port_forwardings: Vec<PortForwarding>,
    #[serde(default)]
    pub codeprints: Vec<Codeprint>,
    #[serde(default)]
    pub sftp_bookmarks: Vec<SftpBookmark>,
    /// The `server_id` of every saved-host tab that was open, in strip
    /// order, so a restart can put them back. Duplicates are meaningful:
    /// two tabs on one host is a normal thing to have open.
    #[serde(default)]
    pub open_tabs: Vec<String>,
    /// Kept opaque: these are xterm themes with many optional colour fields,
    /// and nothing in the backend needs to interpret them.
    #[serde(default)]
    pub custom_themes: std::collections::HashMap<String, serde_json::Value>,
}

/// A record addressed by a string id.
///
/// Lives here rather than beside one of its users because two of them want it:
/// the command layer looks records up by id, and an import has to say where
/// each incoming id ended up.
pub trait Identified {
    fn id(&self) -> &str;
}

macro_rules! identified {
    ($($t:ty),+ $(,)?) => {
        $(impl Identified for $t {
            fn id(&self) -> &str { &self.id }
        })+
    };
}

identified!(Server, Identity, KeyEntry, PortForwarding, Codeprint);

#[cfg(test)]
mod tests {
    use super::*;

    /// The strings on disk and in the TypeScript unions are the contract; a
    /// variant renamed without its serde spelling would silently rewrite every
    /// saved document on the next save.
    #[test]
    fn the_enums_spell_themselves_the_way_the_frontend_does() {
        let json = serde_json::to_string(&Settings {
            app_theme: AppTheme::Amoled,
            host_key_policy: HostKeyPolicy::AcceptNew,
            ..Default::default()
        })
        .unwrap();
        assert!(json.contains(r#""app_theme":"amoled""#), "{}", json);
        assert!(json.contains(r#""host_key_policy":"accept-new""#), "{}", json);

        assert_eq!(
            serde_json::to_string(&Some(AuthKind::KeyboardInteractive)).unwrap(),
            r#""keyboard-interactive""#
        );
        assert_eq!(serde_json::to_string(&PfKind::Dynamic).unwrap(), r#""dynamic""#);
        assert_eq!(serde_json::to_string(&AuthMethod::Key).unwrap(), r#""key""#);
    }

    /// A value outside the set must cost only that field. Failing the whole
    /// document would take every host the user has saved with it, and the
    /// backup copy holds the same edit.
    #[test]
    fn a_value_outside_the_set_falls_back_without_failing_the_document() {
        let data: AppData = serde_json::from_str(
            r#"{
                "servers": [{
                    "id": "s1", "name": "box", "host": "example.com", "port": 22,
                    "auth_kind": "telepathy"
                }],
                "identities": [], "keys": [],
                "settings": { "theme": "t", "font_size": 14, "font_family": "monospace",
                              "cursor_style": "block", "cursor_blink": true,
                              "app_theme": "neon", "host_key_policy": "whatever" },
                "port_forwardings": [{
                    "id": "pf", "label": "rule", "type": "sideways",
                    "bind_address": "127.0.0.1", "local_port": 8080,
                    "intermediate_host_id": null, "remote_host_id": null,
                    "remote_port": null, "dest_address": "example.com", "dest_port": 80
                }]
            }"#,
        )
        .expect("one bad value should not fail the whole document");

        assert_eq!(data.servers[0].host, "example.com");
        assert_eq!(data.servers[0].auth_kind, None);
        assert_eq!(data.settings.app_theme, AppTheme::Dark);
        assert_eq!(data.settings.host_key_policy, HostKeyPolicy::Ask);
        assert_eq!(data.port_forwardings[0].kind, PfKind::Local);
        // Fields added after that document was written take their defaults,
        // which for these two means the feature is on rather than absent.
        assert!(data.settings.restore_tabs);
        assert!(data.settings.shortcuts.is_empty());
        assert!(!data.settings.verify_transfers);
        assert!(data.open_tabs.is_empty());
        // A host saved before the startup command could be hidden keeps the
        // behaviour the app shipped with, which is to hide it.
        assert!(data.servers[0].hide_run_on_connect);
    }

    /// The value the frontend tests against for "nobody has asked this host
    /// yet" is what an absent `os` reads as. The two ends agree by this
    /// constant; nothing else keeps them in step.
    #[test]
    fn a_host_nobody_has_asked_reads_as_undetected() {
        let server: Server = serde_json::from_str(
            r#"{ "id": "s1", "name": "box", "host": "example.com", "port": 22 }"#,
        )
        .unwrap();
        assert_eq!(server.os, UNDETECTED_OS);
        assert!(server.hide_run_on_connect, "hiding the startup command is the default");
    }

    /// A settings file written by an older version, or edited by hand, is
    /// missing whatever it never knew about. Every field takes its default
    /// rather than the document failing and the app falling back to a
    /// backup, which used to happen for four fields that had no default.
    #[test]
    fn a_settings_file_missing_fields_keeps_the_rest_of_the_document() {
        let data: AppData = serde_json::from_str(
            r#"{
                "servers": [{ "id": "s1", "name": "box", "host": "example.com", "port": 22 }],
                "identities": [], "keys": [],
                "settings": { "font_size": 18 }
            }"#,
        )
        .expect("a settings file missing fields should still load");

        assert_eq!(data.settings.font_size, 18, "what it did say is kept");
        assert_eq!(data.settings.theme, Settings::default().theme);
        assert_eq!(data.settings.font_family, "monospace");
        assert!(data.settings.cursor_blink);
        assert_eq!(data.servers.len(), 1, "the rest of the document survives");
    }

    /// And with no settings key at all.
    #[test]
    fn a_document_with_no_settings_takes_them_all() {
        let data: AppData = serde_json::from_str(
            r#"{ "servers": [], "identities": [], "keys": [] }"#,
        )
        .expect("settings are not required to be there");
        assert_eq!(data.settings.scrollback_lines, Settings::default().scrollback_lines);
    }

    /// A host, on the other hand, is not guessable. One missing the address
    /// to connect to would list like any other and fail every time it was
    /// opened, so the document is refused instead.
    #[test]
    fn a_host_without_an_address_is_refused() {
        let parsed = serde_json::from_str::<AppData>(
            r#"{
                "servers": [{ "id": "s1", "name": "box", "port": 22 }],
                "identities": [], "keys": [], "settings": {}
            }"#,
        );
        assert!(parsed.is_err(), "a host with no hostname is not a host");
    }

    #[test]
    fn a_variable_block_reads_in_the_order_it_was_written() {
        assert_eq!(
            env_pairs("LANG=en_GB.UTF-8\nEDITOR=vim"),
            vec![
                ("LANG".to_string(), "en_GB.UTF-8".to_string()),
                ("EDITOR".to_string(), "vim".to_string()),
            ]
        );
    }

    /// Only the first `=` separates; everything after it is the value, which
    /// is how a value holding one of its own survives.
    #[test]
    fn a_value_may_hold_an_equals_sign() {
        assert_eq!(
            env_pairs("OPTS=--flag=1 --other=2"),
            vec![("OPTS".to_string(), "--flag=1 --other=2".to_string())]
        );
    }

    #[test]
    fn blank_lines_comments_and_carriage_returns_are_not_variables() {
        assert_eq!(
            env_pairs("\n  # a note\r\nLANG=C\r\n\n"),
            vec![("LANG".to_string(), "C".to_string())]
        );
    }

    /// A line the server would refuse is dropped here, where the user can be
    /// told, rather than sent and silently discarded on the far side.
    #[test]
    fn a_line_that_is_not_a_variable_is_dropped() {
        assert!(env_pairs("just a sentence").is_empty());
        assert!(env_pairs("2FAST=no").is_empty());
        assert!(env_pairs("has space=no").is_empty());
        assert!(env_pairs("=novalue").is_empty());
    }

    /// Spaces around the name are the user's formatting; spaces in the value
    /// are the value.
    #[test]
    fn spacing_is_trimmed_from_the_name_and_kept_in_the_value() {
        assert_eq!(
            env_pairs("  PAGER = less "),
            vec![("PAGER".to_string(), " less ".to_string())]
        );
    }

    /// Commands are the other direction: nothing has been saved yet, so a
    /// value that is not one of the variants is a mistake worth reporting
    /// rather than one to guess at.
    #[test]
    fn an_unknown_auth_method_is_refused_rather_than_guessed_at() {
        assert!(serde_json::from_str::<AuthMethod>(r#""telepathy""#).is_err());
        assert_eq!(
            serde_json::from_str::<AuthMethod>(r#""keyboard-interactive""#).unwrap(),
            AuthMethod::KeyboardInteractive
        );
    }
}
