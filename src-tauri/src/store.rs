use std::fs;
use std::path::PathBuf;
use anyhow::Result;
use rand::RngCore;

use crate::models::AppData;

pub fn get_data_dir() -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("No home directory found"))?;
    let dir = home.join(".local").join("share").join("bifrossh");
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn load_secret_key() -> Result<[u8; 32]> {
    let path = get_data_dir()?.join(".secret");
    if path.exists() {
        let bytes = fs::read(&path)?;
        if bytes.len() == 32 {
            let mut key = [0u8; 32];
            key.copy_from_slice(&bytes);
            return Ok(key);
        }
    }
    let mut key = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut key);
    fs::write(&path, &key)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
    }
    Ok(key)
}

pub fn load_app_data() -> Result<AppData> {
    let path = get_data_dir()?.join("data.json");
    if path.exists() {
        let content = fs::read_to_string(&path)?;
        Ok(serde_json::from_str(&content)?)
    } else {
        Ok(AppData::default())
    }
}

pub fn save_app_data(data: &AppData) -> Result<()> {
    let path = get_data_dir()?.join("data.json");
    let content = serde_json::to_string_pretty(data)?;
    fs::write(path, content)?;
    Ok(())
}
