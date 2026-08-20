//! Creating, renaming and deleting, on either side.

use super::*;
use super::listing::collect_remote_tree;
use super::session::get_session;

use anyhow::{Context, Result};

pub fn create_local_dir(path: &str) -> Result<()> {
    std::fs::create_dir(path).with_context(|| path.to_string())
}

pub fn delete_local(path: &str) -> Result<()> {
    let meta = std::fs::metadata(path).with_context(|| path.to_string())?;
    if meta.is_dir() {
        std::fs::remove_dir_all(path)
    } else {
        std::fs::remove_file(path)
    }
    .with_context(|| path.to_string())
}

pub fn rename_local(old_path: &str, new_path: &str) -> Result<()> {
    std::fs::rename(old_path, new_path).with_context(|| old_path.to_string())
}

pub async fn delete_remote(
    sftp_state: &SftpClientState,
    session_id: &str,
    path: &str,
    is_dir: bool,
) -> Result<()> {
    let sftp_arc = get_session(sftp_state, session_id).await?;

    if !is_dir {
        let sftp = sftp_arc.lock().await;
        return sftp.remove_file(path).await.with_context(|| path.to_string());
    }

    // remove_dir only works on an empty directory, so the tree has to come out
    // from the leaves upwards. The walk records a directory before its
    // descendants, so reversing the directory list deletes children first.
    let (items, _skipped) = collect_remote_tree(&sftp_arc, path).await?;
    let sftp = sftp_arc.lock().await;

    for item in items.iter().filter(|i| !i.is_dir) {
        let child = join_remote(path, &item.rel);
        sftp.remove_file(&child).await.with_context(|| child.to_string())?;
    }
    for item in items.iter().filter(|i| i.is_dir).rev() {
        let child = join_remote(path, &item.rel);
        sftp.remove_dir(&child).await.with_context(|| child.to_string())?;
    }
    sftp.remove_dir(path).await.with_context(|| path.to_string())
}

pub async fn rename_remote(
    sftp_state: &SftpClientState,
    session_id: &str,
    old_path: &str,
    new_path: &str,
) -> Result<()> {
    let sftp_arc = get_session(sftp_state, session_id).await?;
    let sftp = sftp_arc.lock().await;
    sftp.rename(old_path, new_path)
        .await
        .with_context(|| old_path.to_string())
}

pub async fn mkdir(
    sftp_state: &SftpClientState,
    session_id: &str,
    path: &str,
) -> Result<()> {
    let sftp_arc = get_session(sftp_state, session_id).await?;
    let sftp = sftp_arc.lock().await;
    sftp.create_dir(path).await.with_context(|| path.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

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

    /// The point of carrying anyhow contexts rather than flattening to a
    /// string: `CmdError` renders with `{e:#}`, so the path the operation was
    /// working on reaches the user instead of a bare "No such file".
    #[test]
    fn a_failure_names_the_path_it_was_working_on() {
        let missing = "/nonexistent-bifrossh-test-dir/inner";

        let e = list_local(missing).unwrap_err();
        let shown = format!("{e:#}");
        assert!(shown.contains(missing), "listing: {shown}");
        assert!(shown.contains("No such file"), "listing lost the cause: {shown}");

        let e = delete_local(missing).unwrap_err();
        assert!(format!("{e:#}").contains(missing), "delete: {e:#}");

        let e = create_local_dir(missing).unwrap_err();
        assert!(format!("{e:#}").contains(missing), "mkdir: {e:#}");
    }
}
