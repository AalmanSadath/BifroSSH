//! Reading a directory, on either side, and walking a tree of them.

use super::*;
use super::session::get_session;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use std::time::SystemTime;

use anyhow::{anyhow, Context, Result};
use tokio::sync::Mutex;
use russh_sftp::client::SftpSession;

fn format_mode(mode: u32) -> String {
    let bits = [
        (0o400, 'r'), (0o200, 'w'), (0o100, 'x'),
        (0o040, 'r'), (0o020, 'w'), (0o010, 'x'),
        (0o004, 'r'), (0o002, 'w'), (0o001, 'x'),
    ];
    let prefix = if mode & 0o040000 != 0 { 'd' } else { '-' };
    let s: String = bits.iter().map(|(m, c)| if mode & m != 0 { *c } else { '-' }).collect();
    format!("{}{}", prefix, s)
}

fn file_kind(name: &str, is_dir: bool) -> String {
    if is_dir { return "folder".into(); }
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    match ext.as_str() {
        "rs" => "Rust Source",
        "ts" | "tsx" => "TypeScript",
        "js" | "jsx" => "JavaScript",
        "py" => "Python Script",
        "sh" | "bash" | "zsh" => "Shell Script",
        "txt" | "md" => "Text",
        "pdf" => "PDF",
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "svg" => "Image",
        "zip" | "tar" | "gz" | "bz2" | "xz" | "7z" => "Archive",
        "json" => "JSON",
        "toml" | "yaml" | "yml" => "Config",
        "c" | "h" => "C Source",
        "cpp" | "hpp" => "C++ Source",
        "go" => "Go Source",
        "html" | "htm" => "HTML",
        "css" | "scss" => "Stylesheet",
        _ => "Document",
    }.into()
}

pub fn get_local_home() -> String {
    dirs::home_dir()
        .unwrap_or_else(|| std::path::PathBuf::from("/"))
        .to_string_lossy()
        .into_owned()
}

pub fn list_local(path: &str) -> Result<Vec<FileEntry>> {
    let path_obj = if path.is_empty() || path == "~" {
        dirs::home_dir().unwrap_or_else(|| std::path::PathBuf::from("/"))
    } else {
        std::path::PathBuf::from(path)
    };

    let path_str = path_obj.to_string_lossy().into_owned();
    let read = fs::read_dir(&path_obj).with_context(|| path_str.to_string())?;

    let mut entries: Vec<FileEntry> = Vec::new();

    if let Some(parent) = path_obj.parent() {
        let parent_str = parent.to_string_lossy().into_owned();
        if parent_str != path_str {
            entries.push(FileEntry {
                name: "..".into(),
                path: parent_str,
                is_dir: true,
                size: 0,
                modified: None,
                permissions: String::new(),
                kind: "folder".into(),
            });
        }
    }

    for e in read {
        let Ok(e) = e else { continue; };
        let Ok(meta) = e.metadata() else { continue; };
        let name = e.file_name().to_string_lossy().into_owned();
        let is_dir = meta.is_dir();
        let size = if is_dir { 0 } else { meta.len() };
        let modified = meta.modified().ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());

        #[cfg(unix)]
        let permissions = {
            use std::os::unix::fs::PermissionsExt;
            format_mode(meta.permissions().mode())
        };
        #[cfg(not(unix))]
        let permissions = String::new();

        let kind = file_kind(&name, is_dir);
        let file_path = path_obj.join(&name).to_string_lossy().into_owned();

        entries.push(FileEntry { name, path: file_path, is_dir, size, modified, permissions, kind });
    }

    if entries.len() > 1 {
        entries[1..].sort_by(|a, b| match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
    }

    Ok(entries)
}

pub async fn get_remote_home(sftp_state: &SftpClientState, session_id: &str) -> Result<String> {
    let sftp_arc = get_session(sftp_state, session_id).await?;
    let sftp = sftp_arc.lock().await;
    sftp.canonicalize(".")
        .await
        .context("Could not find the home directory on the server")
}

pub async fn list_remote(
    sftp_state: &SftpClientState,
    session_id: &str,
    path: &str,
) -> Result<Vec<FileEntry>> {
    let sftp_arc = get_session(sftp_state, session_id).await?;
    let sftp = sftp_arc.lock().await;

    let dir_entries = sftp.read_dir(path).await?;

    let mut entries: Vec<FileEntry> = Vec::new();

    if path != "/" {
        let parent = Path::new(path).parent()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|| "/".to_string());
        entries.push(FileEntry {
            name: "..".into(),
            path: parent,
            is_dir: true,
            size: 0,
            modified: None,
            permissions: String::new(),
            kind: "folder".into(),
        });
    }

    for entry in dir_entries {
        let name = entry.file_name();
        if name == "." || name == ".." { continue; }
        let meta = entry.metadata();
        let is_dir = meta.is_dir();
        let size = meta.len();
        let modified = meta.modified().ok()
            .and_then(|t| t.duration_since(SystemTime::UNIX_EPOCH).ok())
            .map(|d| d.as_secs());
        let permissions = String::new();
        let kind = file_kind(&name, is_dir);
        let file_path = if path == "/" { format!("/{}", name) }
            else { format!("{}/{}", path.trim_end_matches('/'), name) };

        entries.push(FileEntry { name, path: file_path, is_dir, size, modified, permissions, kind });
    }

    if entries.len() > 1 {
        entries[1..].sort_by(|a, b| match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        });
    }

    Ok(entries)
}

/// Walks a local directory tree, yielding paths relative to `root`.
///
/// A directory is always recorded before any of its descendants, which callers
/// rely on to create parents first and to delete children first.
///
/// Symlinks are recorded as skipped rather than followed: a link pointing at an
/// ancestor would otherwise recurse until the disk fills.
pub(super) fn collect_local_tree(root: &Path) -> Result<(Vec<TreeItem>, u32)> {
    let mut items = Vec::new();
    let mut skipped = 0u32;
    let mut queue: Vec<(std::path::PathBuf, String, usize)> =
        vec![(root.to_path_buf(), String::new(), 0)];

    while let Some((dir, rel, depth)) = queue.pop() {
        if depth >= MAX_DEPTH {
            return Err(anyhow!("Directory nesting deeper than {} levels", MAX_DEPTH));
        }
        let entries = fs::read_dir(&dir).with_context(|| dir.display().to_string())?;
        for entry in entries {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let child_rel = if rel.is_empty() { name.clone() } else { format!("{}/{}", rel, name) };

            // symlink_metadata so a link is seen as a link, not its target.
            let meta = entry.metadata()?;
            let link = fs::symlink_metadata(entry.path())
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false);

            if link {
                skipped += 1;
            } else if meta.is_dir() {
                items.push(TreeItem { rel: child_rel.clone(), is_dir: true });
                queue.push((entry.path(), child_rel, depth + 1));
            } else if meta.is_file() {
                items.push(TreeItem { rel: child_rel, is_dir: false });
            }
        }
    }
    Ok((items, skipped))
}

/// Remote equivalent of `collect_local_tree`.
///
/// Unlike the local walk, the names here arrive over the wire rather than from
/// a filesystem, so they are checked with `is_safe_name` before being joined.
pub(super) async fn collect_remote_tree(
    sftp_arc: &Arc<Mutex<SftpSession>>,
    root: &str,
) -> Result<(Vec<TreeItem>, u32)> {
    let mut items = Vec::new();
    let mut skipped = 0u32;
    let mut queue: Vec<(String, String, usize)> = vec![(root.to_string(), String::new(), 0)];

    while let Some((dir, rel, depth)) = queue.pop() {
        if depth >= MAX_DEPTH {
            return Err(anyhow!("Directory nesting deeper than {} levels", MAX_DEPTH));
        }
        let read = {
            let sftp = sftp_arc.lock().await;
            sftp.read_dir(&dir).await.with_context(|| dir.to_string())?
        };
        for entry in read {
            let name = entry.file_name();
            // Counted rather than refused: one unusable name should not cost
            // the user the rest of a directory they asked for, which is how
            // symlinks are already handled below.
            if !is_safe_name(&name) {
                skipped += 1;
                continue;
            }
            let child_rel = if rel.is_empty() { name.clone() } else { format!("{}/{}", rel, name) };
            let file_type = entry.file_type();

            if file_type.is_symlink() {
                skipped += 1;
            } else if file_type.is_dir() {
                items.push(TreeItem { rel: child_rel.clone(), is_dir: true });
                queue.push((join_remote(&dir, &name), child_rel, depth + 1));
            } else {
                items.push(TreeItem { rel: child_rel, is_dir: false });
            }
        }
    }
    Ok((items, skipped))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempTree(std::path::PathBuf);
    impl Drop for TempTree {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn temp_tree(name: &str) -> TempTree {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir()
            .join(format!("bifrossh-tree-{}-{}-{}", std::process::id(), name, id));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        TempTree(dir)
    }

    #[test]
    fn walks_nested_directories() {
        let t = temp_tree("nested");
        let root = t.0.join("src");
        fs::create_dir_all(root.join("a/b")).unwrap();
        fs::write(root.join("top.txt"), b"1").unwrap();
        fs::write(root.join("a/mid.txt"), b"2").unwrap();
        fs::write(root.join("a/b/deep.txt"), b"3").unwrap();

        let (items, skipped) = collect_local_tree(&root).unwrap();
        assert_eq!(skipped, 0);

        let mut files: Vec<&str> = items.iter().filter(|i| !i.is_dir).map(|i| i.rel.as_str()).collect();
        files.sort();
        assert_eq!(files, vec!["a/b/deep.txt", "a/mid.txt", "top.txt"]);

        let mut dirs: Vec<&str> = items.iter().filter(|i| i.is_dir).map(|i| i.rel.as_str()).collect();
        dirs.sort();
        assert_eq!(dirs, vec!["a", "a/b"]);
    }

    /// Callers create parents before children and delete children before
    /// parents, both of which depend on this ordering.
    #[test]
    fn parents_are_recorded_before_their_children() {
        let t = temp_tree("order");
        let root = t.0.join("src");
        fs::create_dir_all(root.join("x/y/z")).unwrap();
        fs::write(root.join("x/y/z/f.txt"), b"1").unwrap();

        let (items, _) = collect_local_tree(&root).unwrap();
        let pos = |rel: &str| items.iter().position(|i| i.rel == rel).unwrap();

        assert!(pos("x") < pos("x/y"));
        assert!(pos("x/y") < pos("x/y/z"));
        assert!(pos("x/y/z") < pos("x/y/z/f.txt"));
    }

    /// A link pointing at an ancestor would otherwise be walked forever.
    #[test]
    #[cfg(unix)]
    fn symlinks_are_skipped_not_followed() {
        let t = temp_tree("symlink");
        let root = t.0.join("src");
        fs::create_dir_all(root.join("real")).unwrap();
        fs::write(root.join("real/f.txt"), b"1").unwrap();
        std::os::unix::fs::symlink(&root, root.join("loop")).unwrap();
        std::os::unix::fs::symlink(root.join("real/f.txt"), root.join("link.txt")).unwrap();

        let (items, skipped) = collect_local_tree(&root).unwrap();

        assert_eq!(skipped, 2, "both the directory loop and the file link are skipped");
        assert!(
            !items.iter().any(|i| i.rel.starts_with("loop")),
            "the loop must not be entered"
        );
        assert!(items.iter().any(|i| i.rel == "real/f.txt"));
    }

    #[test]
    fn an_empty_directory_walks_cleanly() {
        let t = temp_tree("empty");
        let root = t.0.join("src");
        fs::create_dir_all(&root).unwrap();

        let (items, skipped) = collect_local_tree(&root).unwrap();
        assert!(items.is_empty());
        assert_eq!(skipped, 0);
    }
}
