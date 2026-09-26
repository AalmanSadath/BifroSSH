//! A session's output kept on disk, as it came off the wire.
//!
//! Escapes and all, the way `script(1)` keeps a session, so `less -R` shows
//! what the terminal showed. One file per session, named for the host and
//! the moment it opened, in a folder of the user's choosing or under the
//! app's own data directory.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};

use crate::store::get_data_dir;

/// Where logs go: the folder from Settings when one is set, else
/// `<data dir>/logs`. Made on the way, private on Unix.
pub fn session_log_dir(configured: Option<&str>) -> Result<PathBuf> {
    private_dir(configured, "logs")
}

/// Where recordings go, in a folder of their own: they are played, not
/// read, and a folder of them is what the Recordings panel lists. The one
/// from Settings when set, else `<data dir>/recordings`.
pub fn recording_dir(configured: Option<&str>) -> Result<PathBuf> {
    private_dir(configured, "recordings")
}

fn private_dir(configured: Option<&str>, default: &str) -> Result<PathBuf> {
    let dir = match configured.map(str::trim).filter(|s| !s.is_empty()) {
        Some(path) => PathBuf::from(path),
        None => get_data_dir()?.join(default),
    };
    std::fs::create_dir_all(&dir).with_context(|| dir.display().to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(dir)
}

/// Opens a fresh log for one session and writes its header line.
pub fn open_session_log(dir: &Path, label: &str, session_id: &str) -> Result<(PathBuf, File)> {
    let now = SystemTime::now();
    let stamp = timestamp(now);
    let path = dir.join(format!("{}.log", file_stem(label, session_id, now)));

    let mut file = private_file(&path)?;
    writeln!(file, "=== BifroSSH session {label} {stamp} ===").with_context(|| path.display().to_string())?;
    Ok((path, file))
}

/// Opens `path` for appending, made if missing, readable by the user alone
/// on Unix: what a session writes is whatever the host printed.
pub(crate) fn private_file(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).with_context(|| path.display().to_string())
}

/// The name a session's file gets, before its extension: the label, when
/// it opened, and the start of its id.
pub(crate) fn file_stem(label: &str, session_id: &str, at: SystemTime) -> String {
    let short = session_id.get(..8).unwrap_or(session_id);
    format!("{}_{}_{}", safe_label(label), timestamp(at), short)
}

/// The label with anything a filesystem or a shell might mind replaced.
fn safe_label(label: &str) -> String {
    let cleaned: String = label
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') { c } else { '_' })
        .collect();
    let trimmed = cleaned.trim_matches(|c| c == '_' || c == '.');
    if trimmed.is_empty() { "session".to_string() } else { trimmed.chars().take(48).collect() }
}

/// `YYYYMMDD-HHMMSS` in UTC.
fn timestamp(at: SystemTime) -> String {
    let secs = at.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (y, m, d) = civil_from_days((secs / 86_400) as i64);
    let rem = secs % 86_400;
    format!("{y:04}{m:02}{d:02}-{:02}{:02}{:02}", rem / 3600, (rem % 3600) / 60, rem % 60)
}

/// Days since 1970-01-01 to a calendar date, Howard Hinnant's algorithm.
/// Fifteen lines are cheaper than a date crate for one filename.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn the_calendar_comes_out_right_around_the_awkward_days() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(-1), (1969, 12, 31));
        assert_eq!(civil_from_days(10_957), (2000, 1, 1));
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
        assert_eq!(civil_from_days(11_017), (2000, 3, 1));
        assert_eq!(civil_from_days(20_723), (2026, 9, 27));
    }

    #[test]
    fn the_stamp_is_utc_to_the_second() {
        let at = UNIX_EPOCH + Duration::from_secs(1_790_000_000);
        assert_eq!(timestamp(at), "20260921-141320");
    }

    /// A host label is whatever the user typed, spaces and slashes included.
    #[test]
    fn a_label_becomes_a_filename_a_shell_will_not_mind() {
        assert_eq!(safe_label("prod web 1"), "prod_web_1");
        assert_eq!(safe_label("../etc/passwd"), "etc_passwd");
        assert_eq!(safe_label("pi@raspi"), "pi_raspi");
        assert_eq!(safe_label("  "), "session");
        assert_eq!(safe_label("naïve"), "na_ve");
    }

    #[test]
    fn a_log_opens_with_its_header_and_appends_after() {
        let dir = std::env::temp_dir().join(format!("bifrossh-log-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        let (path, mut file) = open_session_log(&dir, "raspi", "0123456789abcdef").unwrap();
        file.write_all(b"hello\x1b[0m\n").unwrap();
        drop(file);

        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        assert!(name.starts_with("raspi_"), "{name}");
        assert!(name.ends_with("_01234567.log"), "{name}");
        let text = std::fs::read(&path).unwrap();
        assert!(text.starts_with(b"=== BifroSSH session raspi "));
        assert!(text.ends_with(b"hello\x1b[0m\n"), "escapes are kept as they came");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
