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

/// Which of the three app palettes is in force.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AppTheme {
    #[default]
    Dark,
    Light,
    Amoled,
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
}

impl Server {
    fn default_os() -> String { String::new() }
}

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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub theme: String,
    pub font_size: u16,
    pub font_family: String,
    #[serde(default, deserialize_with = "lenient")]
    pub cursor_style: CursorStyle,
    pub cursor_blink: bool,
    #[serde(default, deserialize_with = "lenient")]
    pub app_theme: AppTheme,
    #[serde(default = "Settings::default_connection_timeout")]
    pub connection_timeout_secs: u32,
    #[serde(default = "Settings::default_show_hover_hints")]
    pub show_hover_hints: bool,
    #[serde(default = "Settings::default_sftp_inactivity_timeout")]
    pub sftp_inactivity_timeout_secs: u32,
    #[serde(default, deserialize_with = "lenient")]
    pub host_key_policy: HostKeyPolicy,
    /// Seconds between keepalives on terminal and tunnel connections; 0 is off.
    /// Stops idle sessions being dropped by NAT and firewall idle timers, and
    /// makes a dead connection surface instead of hanging.
    ///
    /// Not applied to SFTP: those set an inactivity timeout to close idle
    /// sessions, and keepalive traffic would stop it ever firing.
    #[serde(default = "Settings::default_keepalive_interval")]
    pub keepalive_interval_secs: u32,
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
            keepalive_interval_secs: 30,
        }
    }
}

impl Settings {
    fn default_connection_timeout() -> u32 { 60 }
    fn default_show_hover_hints() -> bool { true }
    fn default_sftp_inactivity_timeout() -> u32 { 300 }
    fn default_keepalive_interval() -> u32 { 30 }
}

/// A saved port forwarding rule. Started on demand; never auto-connected.
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
}

/// A named shell command the user can paste or run in any session.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Codeprint {
    pub id: String,
    pub name: String,
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppData {
    pub servers: Vec<Server>,
    pub identities: Vec<Identity>,
    pub keys: Vec<KeyEntry>,
    pub settings: Settings,
    #[serde(default)]
    pub port_forwardings: Vec<PortForwarding>,
    #[serde(default)]
    pub codeprints: Vec<Codeprint>,
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
