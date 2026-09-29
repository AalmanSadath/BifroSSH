//! Files on this computer read and written a piece at a time, for ZMODEM
//! transfers in a terminal: the protocol runs in the terminal's JavaScript,
//! and the bytes on either end of it are here.

use std::fs::OpenOptions;
use std::io::{ErrorKind, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};

use super::{CmdError, CmdResult};

/// The most one read hands back, so a bad length cannot ask for the whole
/// disk at once.
const MAX_CHUNK: u64 = 4 << 20;

/// A name a host offered for a file, made safe to create in the folder the
/// user chose: the last path component only, with nothing that climbs out
/// of that folder or means something to a shell or a file manager.
pub fn safe_name(offered: &str) -> Option<String> {
    clean_name(offered, cfg!(windows))
}

/// `safe_name`, with Windows' rules or without, so both are tested
/// everywhere. On Windows a name such as `C:x` is a path on drive C rather
/// than a name in the folder, `x:y` is an NTFS stream and `nul.txt` a
/// device, so those characters become `_` and a device name gets one in
/// front.
fn clean_name(offered: &str, windows: bool) -> Option<String> {
    use crate::sftp::{is_windows_device, WINDOWS_FORBIDDEN};
    let base = offered.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| if windows && WINDOWS_FORBIDDEN.contains(&c) { '_' } else { c })
        .collect();
    let mut cleaned = cleaned.trim().trim_start_matches('.').trim().to_string();
    if windows {
        cleaned = cleaned.trim_end_matches(['.', ' ']).to_string();
        if is_windows_device(&cleaned) {
            cleaned.insert(0, '_');
        }
    }
    (!cleaned.is_empty()).then_some(cleaned)
}

/// `name`, or `name (1).ext`, `name (2).ext` and so on: the first that does
/// not exist yet in `dir`.
fn candidates(dir: &Path, name: &str) -> impl Iterator<Item = PathBuf> {
    let (stem, ext) = match name.rfind('.') {
        Some(at) if at > 0 => (&name[..at], &name[at..]),
        _ => (name, ""),
    };
    let first = dir.join(name);
    let (dir, stem, ext) = (dir.to_path_buf(), stem.to_string(), ext.to_string());
    std::iter::once(first).chain((1..1000).map(move |n| dir.join(format!("{stem} ({n}){ext}"))))
}

/// Creates a file for a received transfer in `dir`, named as the host
/// offered it but never overwriting anything, and returns where it went.
#[tauri::command]
pub async fn local_file_create(dir: String, name: String) -> CmdResult<String> {
    let name = safe_name(&name).ok_or_else(|| CmdError::from(format!("The host offered a file with no usable name ({name:?})")))?;
    for path in candidates(Path::new(&dir), &name) {
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(_) => return Ok(path.to_string_lossy().into_owned()),
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("Could not create {}: {e}", path.display()).into()),
        }
    }
    Err(format!("Too many files called {name} in {dir} already").into())
}

#[tauri::command]
pub async fn local_file_append(path: String, data: String) -> CmdResult<()> {
    let bytes = BASE64.decode(data).map_err(|e| format!("Bad data for {path}: {e}"))?;
    let mut file = OpenOptions::new()
        .append(true)
        .open(&path)
        .map_err(|e| format!("Could not write {path}: {e}"))?;
    file.write_all(&bytes).map_err(|e| format!("Could not write {path}: {e}").into())
}

/// Up to `len` bytes of a file from `offset`; fewer at the end, none past it.
#[tauri::command]
pub async fn local_file_read_chunk(path: String, offset: u64, len: u64) -> CmdResult<String> {
    let mut file = std::fs::File::open(&path).map_err(|e| format!("Could not read {path}: {e}"))?;
    file.seek(SeekFrom::Start(offset)).map_err(|e| format!("Could not read {path}: {e}"))?;
    let mut buf = Vec::with_capacity(len.min(MAX_CHUNK) as usize);
    file.take(len.min(MAX_CHUNK))
        .read_to_end(&mut buf)
        .map_err(|e| format!("Could not read {path}: {e}"))?;
    Ok(BASE64.encode(buf))
}

/// Size in bytes and modification time in seconds since the epoch, which a
/// ZMODEM offer tells the receiver.
#[derive(serde::Serialize)]
pub struct LocalFileInfo {
    pub size: u64,
    pub mtime: u64,
}

#[tauri::command]
pub async fn local_file_info(path: String) -> CmdResult<LocalFileInfo> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("Could not read {path}: {e}"))?;
    if !meta.is_file() {
        return Err(format!("{path} is not a file").into());
    }
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_secs());
    Ok(LocalFileInfo { size: meta.len(), mtime })
}

/// Takes away a file a cancelled transfer left half written.
#[tauri::command]
pub async fn local_file_remove(path: String) -> CmdResult<()> {
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("Could not remove {path}: {e}").into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A host decides the name; it does not get to decide the folder.
    #[test]
    fn an_offered_name_cannot_leave_the_chosen_folder() {
        assert_eq!(safe_name("report.pdf").as_deref(), Some("report.pdf"));
        assert_eq!(safe_name("../../.bashrc").as_deref(), Some("bashrc"));
        assert_eq!(safe_name("/etc/passwd").as_deref(), Some("passwd"));
        assert_eq!(safe_name("..\\..\\win.ini").as_deref(), Some("win.ini"));
        assert_eq!(safe_name("a\u{1b}[2Jb\n.txt").as_deref(), Some("a[2Jb.txt"));
        assert_eq!(safe_name(".."), None);
        assert_eq!(safe_name("dir/"), None);
        assert_eq!(safe_name(""), None);
    }

    /// On Windows the folder is still the one chosen, whatever the name.
    #[test]
    fn an_offered_name_is_made_one_windows_takes_as_a_plain_name() {
        assert_eq!(clean_name("C:evil.bat", true).as_deref(), Some("C_evil.bat"));
        assert_eq!(clean_name("notes.txt:hidden", true).as_deref(), Some("notes.txt_hidden"));
        assert_eq!(clean_name("what?.txt", true).as_deref(), Some("what_.txt"));
        assert_eq!(clean_name("nul.txt", true).as_deref(), Some("_nul.txt"));
        assert_eq!(clean_name("trailing. ", true).as_deref(), Some("trailing"));
        assert_eq!(clean_name("...", true), None);
        // Elsewhere those are ordinary characters, and kept.
        assert_eq!(clean_name("10:30.log", false).as_deref(), Some("10:30.log"));
        assert_eq!(clean_name("nul.txt", false).as_deref(), Some("nul.txt"));
    }

    #[tokio::test]
    async fn a_received_file_never_overwrites_and_reads_back_in_pieces() {
        let dir = std::env::temp_dir().join(format!("bifrossh-zm-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let d = dir.to_string_lossy().into_owned();

        let first = local_file_create(d.clone(), "notes.txt".into()).await.unwrap();
        let second = local_file_create(d.clone(), "notes.txt".into()).await.unwrap();
        assert!(first.ends_with("notes.txt"));
        assert!(second.ends_with("notes (1).txt"), "{second}");

        local_file_append(first.clone(), BASE64.encode(b"hello ")).await.unwrap();
        local_file_append(first.clone(), BASE64.encode(b"world")).await.unwrap();
        let piece = local_file_read_chunk(first.clone(), 6, 100).await.unwrap();
        assert_eq!(BASE64.decode(piece).unwrap(), b"world");
        assert_eq!(local_file_info(first.clone()).await.unwrap().size, 11);

        local_file_remove(second.clone()).await.unwrap();
        assert!(!Path::new(&second).exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
