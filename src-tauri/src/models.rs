use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Server {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub identity_id: Option<String>,
    #[serde(default)]
    pub theme: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Identity {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub username: String,
    pub key_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct KeyEntry {
    #[serde(default)]
    pub id: String,
    pub name: String,
    pub key_path: Option<String>,
    pub encrypted_key: Option<String>,
    pub encrypted_passphrase: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub theme: String,
    pub font_size: u16,
    pub font_family: String,
    pub cursor_style: String,
    pub cursor_blink: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            theme: "bifrossh-dark".to_string(),
            font_size: 14,
            font_family: "monospace".to_string(),
            cursor_style: "block".to_string(),
            cursor_blink: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppData {
    pub servers: Vec<Server>,
    pub identities: Vec<Identity>,
    pub keys: Vec<KeyEntry>,
    pub settings: Settings,
}
