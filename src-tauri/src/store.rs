use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use anyhow::{Context, Result};

use crate::models::AppData;

pub const DATA_FILE: &str = "data.json";
/// One step of history, replaced on every save. See [`save_app_data_in`].
const BACKUP_FILE: &str = "data.json.bak";
/// A file that would not parse, set aside so the next save cannot copy it over
/// the backup that was just used to recover from it.
const CORRUPT_FILE: &str = "data.json.corrupt";
const TEMP_FILE: &str = "data.json.tmp";

/// Modes are set explicitly rather than left to the process umask, which on a
/// typical system yields 0755 and 0644.
///
/// The credentials in data.json are encrypted, but nothing else in it is: the
/// hostnames, usernames, jump host chains, forwarding rules and saved commands
/// are all plain text, and together they map out whatever infrastructure the
/// user reaches from here. That is not something to leave readable by every
/// other account on the machine.
const DIR_MODE: u32 = 0o700;
const FILE_MODE: u32 = 0o600;

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    if fs::metadata(path)?.permissions().mode() & 0o777 != mode {
        fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    }
    Ok(())
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> Result<()> {
    Ok(())
}

/// Narrows a file to owner-only.
///
/// Here rather than beside each caller because this is the module that decides
/// what "private" means on disk, and known_hosts wants the same answer as the
/// vault. Reads the mode first so the common case of a file already correct
/// costs nothing.
pub fn make_private(path: &Path) -> Result<()> {
    set_mode(path, FILE_MODE)
}

/// Creates the file already private, so it never exists at a wider mode even
/// briefly.
fn create_private(path: &Path) -> Result<fs::File> {
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(FILE_MODE);
    }
    Ok(opts.open(path)?)
}

/// Writes a file that is private from the moment it exists and is on the disk
/// before this returns.
pub fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
    let mut file = create_private(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

pub fn get_data_dir() -> Result<PathBuf> {
    let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("No home directory found"))?;
    let dir = home.join(".local").join("share").join("bifrossh");
    fs::create_dir_all(&dir)?;
    let _ = set_mode(&dir, DIR_MODE);
    Ok(dir)
}

/// What data.json holds now: one AES-GCM box around the whole document.
///
/// Only the credential fields used to be encrypted, which left the hostnames,
/// usernames, jump host chains, forwarding rules and saved commands in plain
/// text. Those describe the infrastructure this machine reaches, and are worth
/// as much to somebody who finds the file as the passwords are.
///
/// The per field encryption underneath is kept as it was. Re-encrypting those
/// values would mean rewriting every credential in place, and an interruption
/// halfway through that loses them. It also means an AppData sitting in memory
/// still does not hold plaintext passwords.
#[derive(serde::Serialize, serde::Deserialize)]
struct Envelope {
    version: u32,
    ciphertext: String,
}

fn read_file(path: &Path, key: &[u8; 32]) -> Result<AppData> {
    let content = fs::read_to_string(path)
        .with_context(|| format!("reading {}", path.display()))?;

    // An envelope and a bare AppData cannot be mistaken for one another: the
    // envelope has no servers or settings, and AppData has no ciphertext.
    if let Ok(envelope) = serde_json::from_str::<Envelope>(&content) {
        let plain = crate::crypto::decrypt(&envelope.ciphertext, key)
            .with_context(|| format!("decrypting {}", path.display()))?;
        return serde_json::from_slice(&plain)
            .with_context(|| format!("parsing the contents of {}", path.display()));
    }

    // Written by a version before the file was encrypted. Readable as is; the
    // next save writes it back as an envelope.
    serde_json::from_str(&content).with_context(|| format!("parsing {}", path.display()))
}

pub fn load_app_data(key: &[u8; 32]) -> Result<AppData> {
    load_app_data_in(&get_data_dir()?, key)
}

pub fn save_app_data(data: &AppData, key: &[u8; 32]) -> Result<()> {
    save_app_data_in(&get_data_dir()?, data, key)
}

/// Split from [`load_app_data`] so the recovery paths can be tested against a
/// temporary directory. Going through the real one would mean overriding HOME,
/// which is process wide and would race the tests that already do it.
pub fn load_app_data_in(dir: &Path, key: &[u8; 32]) -> Result<AppData> {
    let path = dir.join(DATA_FILE);
    let backup = dir.join(BACKUP_FILE);

    // No file at all is a first run. Reaching for the backup here would
    // resurrect data on a machine where the user deliberately cleared it.
    if !path.exists() {
        return Ok(AppData::default());
    }

    // Installations that predate this are sitting at 0644 and will not be
    // rewritten until the user happens to change something.
    let _ = set_mode(&path, FILE_MODE);

    let err = match read_file(&path, key) {
        Ok(data) => return Ok(data),
        Err(e) => e,
    };
    if !backup.exists() {
        return Err(err);
    }
    let recovered = read_file(&backup, key)
        .with_context(|| format!("{} is unreadable and so is its backup", path.display()))?;

    eprintln!(
        "{} could not be read ({err:#}); recovered from {}",
        path.display(),
        backup.display()
    );

    // Put the unreadable file beyond reach of the next save, which would
    // otherwise copy it straight over the backup that just rescued it, and
    // restore the backup in its place so a crash before the next save does not
    // come back to an empty app.
    let _ = fs::rename(&path, dir.join(CORRUPT_FILE));
    if let Err(e) = fs::copy(&backup, &path) {
        eprintln!("Could not restore {} from its backup: {e}", path.display());
    } else {
        let _ = set_mode(&path, FILE_MODE);
    }

    Ok(recovered)
}

/// Writes `data` so that an interrupted save cannot destroy what was already
/// there, and leaves the previous contents behind as a backup.
///
/// The old code was a single `fs::write`, which opens the real file with
/// O_TRUNC: a crash, a full disk or a killed process between the truncate and
/// the last byte left data.json empty or half written, taking every server,
/// identity and key with it. Here the replacement is written and flushed
/// beside it and then renamed over the top, which is atomic, so data.json is
/// always one whole version or the other.
///
/// The backup is one deep and is refreshed on every save. That covers a file
/// this app damaged, and an accidental deletion noticed before the next save.
/// It is not history: the save after a mistake overwrites it.
pub fn save_app_data_in(dir: &Path, data: &AppData, key: &[u8; 32]) -> Result<()> {
    let path = dir.join(DATA_FILE);
    let temp = dir.join(TEMP_FILE);
    let backup = dir.join(BACKUP_FILE);

    let content = serde_json::to_string_pretty(&Envelope {
        version: 1,
        ciphertext: crate::crypto::encrypt(serde_json::to_vec(data)?.as_slice(), key)?,
    })?;

    let mut file = create_private(&temp)?;
    file.write_all(content.as_bytes())?;
    // Without this the rename can land before the contents do, and a power
    // loss leaves data.json pointing at a block of nothing.
    file.sync_all()?;
    drop(file);

    // Copied rather than renamed so that data.json is never briefly absent.
    // Best effort: not keeping a backup is a worse outcome than a failed save,
    // but only just, and refusing to save would be worse than both.
    if path.exists() {
        match fs::copy(&path, &backup) {
            Ok(_) => {
                let _ = set_mode(&backup, FILE_MODE);
            }
            Err(e) => eprintln!("Could not refresh {}: {e}", backup.display()),
        }
    }

    fs::rename(&temp, &path)?;
    let _ = set_mode(&path, FILE_MODE);

    // The rename itself needs flushing too, or the directory entry can still
    // be the old one after a crash.
    if let Ok(handle) = fs::File::open(dir) {
        let _ = handle.sync_all();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    const KEY: [u8; 32] = [42u8; 32];

    static COUNTER: AtomicU32 = AtomicU32::new(0);

    fn temp_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "bifrossh-store-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn data_named(name: &str) -> AppData {
        let mut data = AppData::default();
        data.codeprints.push(crate::models::Codeprint {
            id: "id".to_string(),
            name: name.to_string(),
            command: "true".to_string(),
        });
        data
    }

    fn only_codeprint(data: &AppData) -> &str {
        &data.codeprints[0].name
    }

    #[test]
    fn a_saved_file_can_be_read_back() {
        let dir = temp_dir();
        save_app_data_in(&dir, &data_named("first"), &KEY).unwrap();
        assert_eq!(only_codeprint(&load_app_data_in(&dir, &KEY).unwrap()), "first");
    }

    #[cfg(unix)]
    #[test]
    fn saved_files_are_not_readable_by_other_accounts() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir();
        save_app_data_in(&dir, &data_named("first"), &KEY).unwrap();
        save_app_data_in(&dir, &data_named("second"), &KEY).unwrap();

        for name in [DATA_FILE, BACKUP_FILE] {
            let mode = fs::metadata(dir.join(name)).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, FILE_MODE, "{name} is mode {mode:o}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn an_existing_world_readable_file_is_tightened_on_load() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir();
        let path = dir.join(DATA_FILE);
        save_app_data_in(&dir, &data_named("first"), &KEY).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();

        load_app_data_in(&dir, &KEY).unwrap();

        let mode = fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, FILE_MODE, "left at {mode:o}");
    }

    #[test]
    fn the_backup_holds_the_state_before_the_last_save() {
        let dir = temp_dir();
        save_app_data_in(&dir, &data_named("first"), &KEY).unwrap();
        save_app_data_in(&dir, &data_named("second"), &KEY).unwrap();

        assert_eq!(only_codeprint(&read_file(&dir.join(DATA_FILE), &KEY).unwrap()), "second");
        assert_eq!(only_codeprint(&read_file(&dir.join(BACKUP_FILE), &KEY).unwrap()), "first");
    }

    #[test]
    fn the_first_save_has_nothing_to_back_up() {
        let dir = temp_dir();
        save_app_data_in(&dir, &data_named("first"), &KEY).unwrap();
        assert!(!dir.join(BACKUP_FILE).exists());
    }

    #[test]
    fn no_temporary_file_is_left_behind() {
        let dir = temp_dir();
        save_app_data_in(&dir, &data_named("first"), &KEY).unwrap();
        assert!(!dir.join(TEMP_FILE).exists());
    }

    #[test]
    fn a_missing_file_is_a_first_run_rather_than_a_loss() {
        let dir = temp_dir();
        // A backup on its own is not enough to conclude data was lost; the user
        // may have cleared the app deliberately.
        fs::write(dir.join(BACKUP_FILE), "{\"servers\":[]}").unwrap();
        assert!(load_app_data_in(&dir, &KEY).unwrap().codeprints.is_empty());
    }

    #[test]
    fn a_truncated_file_is_recovered_from_the_backup() {
        let dir = temp_dir();
        save_app_data_in(&dir, &data_named("first"), &KEY).unwrap();
        save_app_data_in(&dir, &data_named("second"), &KEY).unwrap();
        // What the old non-atomic write produced when it was interrupted.
        fs::write(dir.join(DATA_FILE), "").unwrap();

        assert_eq!(only_codeprint(&load_app_data_in(&dir, &KEY).unwrap()), "first");
    }

    #[test]
    fn recovery_repairs_the_live_file_so_the_next_launch_is_not_empty() {
        let dir = temp_dir();
        save_app_data_in(&dir, &data_named("first"), &KEY).unwrap();
        save_app_data_in(&dir, &data_named("second"), &KEY).unwrap();
        fs::write(dir.join(DATA_FILE), "{ truncated").unwrap();

        load_app_data_in(&dir, &KEY).unwrap();

        // Reading again must not depend on the backup a second time.
        fs::remove_file(dir.join(BACKUP_FILE)).unwrap();
        assert_eq!(only_codeprint(&load_app_data_in(&dir, &KEY).unwrap()), "first");
    }

    #[test]
    fn the_unreadable_file_is_kept_but_cannot_reach_the_backup() {
        let dir = temp_dir();
        save_app_data_in(&dir, &data_named("first"), &KEY).unwrap();
        save_app_data_in(&dir, &data_named("second"), &KEY).unwrap();
        fs::write(dir.join(DATA_FILE), "{ truncated").unwrap();

        load_app_data_in(&dir, &KEY).unwrap();
        assert_eq!(
            fs::read_to_string(dir.join(CORRUPT_FILE)).unwrap(),
            "{ truncated"
        );

        // The save that follows a recovery must not copy the damaged file over
        // the backup that just rescued it.
        save_app_data_in(&dir, &data_named("third"), &KEY).unwrap();
        assert_eq!(only_codeprint(&read_file(&dir.join(BACKUP_FILE), &KEY).unwrap()), "first");
    }

    #[test]
    fn a_plaintext_file_from_an_older_version_is_read_and_then_encrypted() {
        let dir = temp_dir();
        let path = dir.join(DATA_FILE);
        // Exactly what versions before the envelope wrote.
        let plain = serde_json::to_string_pretty(&data_named("legacy")).unwrap();
        fs::write(&path, &plain).unwrap();

        assert_eq!(only_codeprint(&load_app_data_in(&dir, &KEY).unwrap()), "legacy");

        save_app_data_in(&dir, &load_app_data_in(&dir, &KEY).unwrap(), &KEY).unwrap();
        let written = fs::read_to_string(&path).unwrap();
        assert!(written.contains("ciphertext"), "still plaintext: {written}");
        assert!(!written.contains("legacy"), "codeprint name left in the clear");
        assert_eq!(only_codeprint(&load_app_data_in(&dir, &KEY).unwrap()), "legacy");
    }

    #[test]
    fn the_wrong_master_key_does_not_silently_return_an_empty_app() {
        let dir = temp_dir();
        save_app_data_in(&dir, &data_named("first"), &KEY).unwrap();
        // A keyring that handed back the wrong key must be an error, never a
        // default AppData that the next save would write over the real data.
        assert!(load_app_data_in(&dir, &[7u8; 32]).is_err());
    }

    #[test]
    fn nothing_readable_is_left_in_the_saved_file() {
        let dir = temp_dir();
        let mut data = data_named("secret-command");
        data.servers.push(crate::models::Server {
            id: "s".into(), name: "bastion".into(), host: "10.0.0.1".into(), port: 22,
            identity_id: None, username: Some("root".into()), encrypted_password: None,
            key_id: None, theme: None, os: String::new(), connection_timeout: None,
            auth_kind: None, proxy_jump: None,
        });
        save_app_data_in(&dir, &data, &KEY).unwrap();

        let written = fs::read_to_string(dir.join(DATA_FILE)).unwrap();
        for leaked in ["bastion", "10.0.0.1", "root", "secret-command"] {
            assert!(!written.contains(leaked), "{leaked} is in the clear:\n{written}");
        }
    }

    #[test]
    fn a_corrupt_file_with_no_backup_is_an_error_rather_than_a_silent_reset() {
        let dir = temp_dir();
        fs::write(dir.join(DATA_FILE), "{ truncated").unwrap();
        // Returning a default here would look like a fresh install, and the
        // first save would then overwrite whatever might still be salvageable.
        assert!(load_app_data_in(&dir, &KEY).is_err());
    }
}
