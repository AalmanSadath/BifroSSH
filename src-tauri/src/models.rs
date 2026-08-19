use serde::{Deserialize, Serialize};

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
    /// "keyboard-interactive" selects PAM/2FA challenge-response. None means
    /// the credential fields decide, as before.
    #[serde(default)]
    pub auth_kind: Option<String>,
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
    #[serde(default)]
    pub auth_kind: Option<String>,
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
    pub cursor_style: String,
    pub cursor_blink: bool,
    #[serde(default = "Settings::default_app_theme")]
    pub app_theme: String,
    #[serde(default = "Settings::default_connection_timeout")]
    pub connection_timeout_secs: u32,
    #[serde(default = "Settings::default_show_hover_hints")]
    pub show_hover_hints: bool,
    #[serde(default = "Settings::default_sftp_inactivity_timeout")]
    pub sftp_inactivity_timeout_secs: u32,
    /// "ask" | "accept-new" | "strict". A mismatch is blocked under all three.
    #[serde(default = "Settings::default_host_key_policy")]
    pub host_key_policy: String,
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
            cursor_style: "block".to_string(),
            cursor_blink: true,
            app_theme: "dark".to_string(),
            connection_timeout_secs: 60,
            show_hover_hints: true,
            sftp_inactivity_timeout_secs: 300,
            host_key_policy: "ask".to_string(),
            keepalive_interval_secs: 30,
        }
    }
}

impl Settings {
    fn default_app_theme() -> String { "dark".to_string() }
    fn default_connection_timeout() -> u32 { 60 }
    fn default_show_hover_hints() -> bool { true }
    fn default_sftp_inactivity_timeout() -> u32 { 300 }
    fn default_host_key_policy() -> String { "ask".to_string() }
    fn default_keepalive_interval() -> u32 { 30 }
}

/// A saved port forwarding rule. Started on demand; never auto-connected.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortForwarding {
    pub id: String,
    pub label: String,
    #[serde(rename = "type")]
    pub kind: String,
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
