//! SFTP against a real server.
//!
//! Every listing, transfer and operation in this module used to be covered
//! by reading the code and by hand. The symlink stat and the handle close
//! both shipped that way. This boots an `sshd` as the current user on a
//! loopback port, with keys it makes itself and `internal-sftp` as the
//! subsystem, and drives the module's own functions at it.
//!
//! No sudo, nothing under `/etc/ssh` or `~/.ssh`, and the server dies with
//! the test. Skipped, loudly, where `sshd` or `ssh-keygen` is not installed.

use super::*;
use super::listing::list_remote;
use super::ops::{delete_remote, mkdir, rename_remote, set_mode_remote};
use super::edit::{watch, EditEvent};
use super::transfer::{conflicts, download_path, upload_path, upload_quiet, Conflict, Silent};

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

use russh::client;
use russh_keys::key::PublicKey;
use russh_sftp::client::SftpSession;
use tokio::sync::Mutex;

/// The server is a key this test made a moment ago; there is nothing to verify.
struct TrustEverything;
#[async_trait::async_trait]
impl client::Handler for TrustEverything {
    type Error = russh::Error;
    async fn check_server_key(&mut self, _: &PublicKey) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

/// A running sshd and the directory it lives in. Both go away on drop.
struct Server {
    child: Child,
    dir: PathBuf,
    port: u16,
    client_key: PathBuf,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl Server {
    /// Somewhere under the server's directory for a test to put files.
    fn scratch(&self, name: &str) -> PathBuf {
        let p = self.dir.join("scratch").join(name);
        std::fs::create_dir_all(&p).unwrap();
        p
    }
}

fn free_port() -> Option<u16> {
    let l = std::net::TcpListener::bind("127.0.0.1:0").ok()?;
    Some(l.local_addr().ok()?.port())
}

/// Boots an sshd, or None when the machine cannot. `nofile` caps the soft
/// file descriptor limit the server runs under, which is what decides the
/// `max-open-handles` it advertises; None leaves it alone.
fn spawn_sshd(name: &str, nofile: Option<u32>) -> Option<Server> {
    if !Path::new("/usr/sbin/sshd").exists() {
        return None;
    }
    let dir = std::env::temp_dir().join(format!("bifrossh-sshd-{}-{}", std::process::id(), name));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).ok()?;

    let keygen = |path: &Path| {
        Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-C", "", "-f"])
            .arg(path)
            .status()
            .ok()
            .is_some_and(|s| s.success())
    };
    let host_key = dir.join("host_key");
    let client_key = dir.join("client_key");
    if !keygen(&host_key) || !keygen(&client_key) {
        return None;
    }

    let port = free_port()?;
    let config = dir.join("sshd_config");
    std::fs::write(
        &config,
        format!(
            "ListenAddress 127.0.0.1\n\
             Port {port}\n\
             HostKey {host}\n\
             AuthorizedKeysFile {auth}\n\
             PidFile none\n\
             StrictModes no\n\
             UsePAM no\n\
             PasswordAuthentication no\n\
             KbdInteractiveAuthentication no\n\
             Subsystem sftp internal-sftp\n\
             LogLevel ERROR\n",
            host = host_key.display(),
            auth = client_key.with_extension("pub").display(),
        ),
    )
    .ok()?;

    // Through a shell so the descriptor limit can be lowered for the server
    // and only the server. ulimit can lower a soft limit without privilege.
    let log = std::fs::File::create(dir.join("sshd.log")).ok()?;
    let mut script = String::new();
    if let Some(n) = nofile {
        script.push_str(&format!("ulimit -n {n} && "));
    }
    script.push_str(&format!("exec /usr/sbin/sshd -D -e -f '{}'", config.display()));
    let child = Command::new("sh")
        .args(["-c", &script])
        .stdout(Stdio::null())
        .stderr(log)
        .spawn()
        .ok()?;

    let server = Server { child, dir, port, client_key };

    // sshd -D returns at once; the port opens a moment later.
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            return Some(server);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    None
}

/// Connects the way `session.rs` does and registers the session under `id`.
async fn connect(server: &Server, state: &SftpClientState, id: &str) {
    let config = Arc::new(client::Config::default());
    let stream = tokio::net::TcpStream::connect(("127.0.0.1", server.port)).await.unwrap();
    let mut handle = client::connect_stream(config, stream, TrustEverything).await.unwrap();

    let user = std::env::var("USER").unwrap_or_else(|_| "test".into());
    let key = russh_keys::load_secret_key(&server.client_key, None).unwrap();
    assert!(handle.authenticate_publickey(&user, Arc::new(key)).await.unwrap(), "key auth");

    let channel = handle.channel_open_session().await.unwrap();
    channel.request_subsystem(true, "sftp").await.unwrap();
    let sftp = SftpSession::new(channel.into_stream()).await.unwrap();

    state.sessions.lock().await.insert(id.to_string(), Arc::new(Mutex::new(sftp)));
    drop(handle);
}

/// Everything a test needs, or None with the reason printed.
async fn rig(name: &str, nofile: Option<u32>) -> Option<(Server, SftpClientState)> {
    let Some(server) = spawn_sshd(name, nofile) else {
        eprintln!("skipping {name}: sshd or ssh-keygen unavailable");
        return None;
    };
    let state = SftpClientState::new();
    connect(&server, &state, "s").await;
    Some((server, state))
}

fn write_files(dir: &Path, count: usize) {
    for i in 0..count {
        std::fs::write(dir.join(format!("f{i:04}.txt")), format!("file {i}\n")).unwrap();
    }
}

#[tokio::test]
async fn a_remote_symlink_to_a_directory_lists_as_a_directory() {
    let Some((server, state)) = rig("symlink", None).await else { return };
    let root = server.scratch("links");
    std::fs::create_dir(root.join("real")).unwrap();
    std::fs::write(root.join("real/inside.txt"), b"x").unwrap();
    std::os::unix::fs::symlink(root.join("real"), root.join("link")).unwrap();
    std::os::unix::fs::symlink(root.join("gone"), root.join("dangling")).unwrap();

    let entries = list_remote(&state, "s", &root.to_string_lossy()).await.unwrap();
    let by_name = |n: &str| entries.iter().find(|e| e.name == n).unwrap_or_else(|| panic!("{n} listed"));

    let link = by_name("link");
    assert!(link.is_dir, "READDIR said file; the stat must say directory");
    assert!(link.symlink);
    assert!(!by_name("real").symlink);

    let dangling = by_name("dangling");
    assert!(!dangling.is_dir);
    assert!(dangling.symlink, "a broken link is still listed, and still a link");
}

/// Every file dropped rather than closed leaves the client's handle count one
/// higher, and the client refuses to open anything once that count reaches
/// what the server advertised. The server takes that number from its own
/// descriptor limit, so the limit here is 64 and the directory holds 100.
#[tokio::test]
async fn a_directory_with_more_files_than_the_handle_limit_downloads() {
    let Some((server, state)) = rig("handles", Some(64)).await else { return };
    let src = server.scratch("many");
    write_files(&src, 100);
    let dst = server.scratch("many-out");

    let summary = download_path(&Silent, &state, "s", &src.to_string_lossy(), &dst.to_string_lossy(), Conflict::Overwrite)
        .await
        .expect("a transfer of 100 files under a limit of 64");
    assert_eq!(summary.files, 100);
    assert!(!summary.cancelled);

    // And the session is still usable afterward, which is the half the panel
    // showed as "disconnected".
    let after = list_remote(&state, "s", &src.to_string_lossy()).await.unwrap();
    assert_eq!(after.iter().filter(|e| e.name != "..").count(), 100);

    for i in 0..100 {
        let name = format!("f{i:04}.txt");
        assert_eq!(std::fs::read_to_string(dst.join("many").join(&name)).unwrap(), format!("file {i}\n"));
    }
}

#[tokio::test]
async fn an_uploaded_tree_reads_back_byte_for_byte() {
    let Some((server, state)) = rig("upload", None).await else { return };
    let src = server.scratch("tree");
    std::fs::create_dir_all(src.join("a/b")).unwrap();
    std::fs::write(src.join("top.txt"), b"top").unwrap();
    std::fs::write(src.join("a/mid.txt"), vec![7u8; 300_000]).unwrap();
    std::fs::write(src.join("a/b/deep.txt"), b"deep").unwrap();
    let dst = server.scratch("tree-out");

    let summary = upload_path(&Silent, &state, "s", &src.to_string_lossy(), &dst.to_string_lossy(), Conflict::Overwrite)
        .await
        .unwrap();
    assert_eq!(summary.files, 3);
    assert_eq!(summary.directories, 2, "a and a/b; the root is made but not counted");

    let out = dst.join("tree");
    assert_eq!(std::fs::read(out.join("top.txt")).unwrap(), b"top");
    assert_eq!(std::fs::read(out.join("a/mid.txt")).unwrap(), vec![7u8; 300_000]);
    assert_eq!(std::fs::read(out.join("a/b/deep.txt")).unwrap(), b"deep");
}

#[tokio::test]
async fn mkdir_rename_and_delete_over_the_wire() {
    let Some((server, state)) = rig("ops", None).await else { return };
    let root = server.scratch("ops");
    let path = |n: &str| root.join(n).to_string_lossy().into_owned();

    mkdir(&state, "s", &path("made")).await.unwrap();
    assert!(root.join("made").is_dir());

    std::fs::write(root.join("old.txt"), b"x").unwrap();
    rename_remote(&state, "s", &path("old.txt"), &path("new.txt")).await.unwrap();
    assert!(!root.join("old.txt").exists());
    assert!(root.join("new.txt").exists());

    delete_remote(&state, "s", &path("new.txt"), false).await.unwrap();
    assert!(!root.join("new.txt").exists());

    std::fs::write(root.join("made/inner.txt"), b"x").unwrap();
    delete_remote(&state, "s", &path("made"), true).await.unwrap();
    assert!(!root.join("made").exists(), "a directory is removed with what is in it");
}

#[tokio::test]
async fn the_remote_home_is_where_the_server_started() {
    let Some((_server, state)) = rig("home", None).await else { return };
    let home = listing::get_remote_home(&state, "s").await.unwrap();
    assert_eq!(home, std::env::var("HOME").unwrap());
}

/// `FileAttributes::default()` fills size, uid, gid and both times rather
/// than leaving them out; a setstat built from it for a mode-only change
/// would truncate the file and reset its owner and dates. This pins the
/// content and size staying put, on top of the mode actually landing.
#[tokio::test]
async fn setting_the_mode_touches_only_the_mode() {
    let Some((server, state)) = rig("chmod", None).await else { return };
    let root = server.scratch("chmod");
    let path = root.join("f.txt");
    std::fs::write(&path, b"hello world").unwrap();

    set_mode_remote(&state, "s", &path.to_string_lossy(), 0o600).await.unwrap();

    let entries = list_remote(&state, "s", &root.to_string_lossy()).await.unwrap();
    let f = entries.iter().find(|e| e.name == "f.txt").unwrap();
    assert_eq!(f.mode, Some(0o600));
    assert_eq!(f.permissions, "-rw-------");

    assert_eq!(std::fs::read(&path).unwrap(), b"hello world", "contents must survive a chmod");
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
}

/// Three answers to a file that is already there, and the question that
/// comes before them.
#[tokio::test]
async fn a_file_already_there_is_overwritten_skipped_or_kept_as_asked() {
    let Some((server, state)) = rig("conflict", None).await else { return };
    let src = server.scratch("conflict-src");
    let dst = server.scratch("conflict-dst");
    std::fs::write(src.join("f.txt"), b"new").unwrap();
    std::fs::write(dst.join("f.txt"), b"old").unwrap();
    let (src_file, dst_dir) = (src.join("f.txt").to_string_lossy().into_owned(), dst.to_string_lossy().into_owned());
    let up = |policy| upload_path(&Silent, &state, "s", &src_file, &dst_dir, policy);

    let summary = up(Conflict::Skip).await.unwrap();
    assert_eq!((summary.files, summary.skipped_existing), (0, 1));
    assert_eq!(std::fs::read(dst.join("f.txt")).unwrap(), b"old", "skip leaves the old file");

    let summary = up(Conflict::KeepBoth).await.unwrap();
    assert_eq!((summary.files, summary.skipped_existing), (1, 0));
    assert_eq!(std::fs::read(dst.join("f.txt")).unwrap(), b"old", "keep both leaves the old file too");
    assert_eq!(std::fs::read(dst.join("f (2).txt")).unwrap(), b"new");
    up(Conflict::KeepBoth).await.unwrap();
    assert_eq!(std::fs::read(dst.join("f (3).txt")).unwrap(), b"new", "and counts on from there");

    up(Conflict::Overwrite).await.unwrap();
    assert_eq!(std::fs::read(dst.join("f.txt")).unwrap(), b"new");
}

/// The list the panel asks for before asking the user: exactly the files
/// that would be written over, relative to the item, and nothing else.
#[tokio::test]
async fn a_tree_names_only_the_files_that_would_be_written_over() {
    let Some((server, state)) = rig("conflicts", None).await else { return };
    let src = server.scratch("tree-src").join("proj");
    std::fs::create_dir_all(src.join("sub")).unwrap();
    for n in ["a.txt", "b.txt", "sub/c.txt", "sub/d.txt"] {
        std::fs::write(src.join(n), b"x").unwrap();
    }
    let dst = server.scratch("tree-dst");
    std::fs::create_dir_all(dst.join("proj/sub")).unwrap();
    std::fs::write(dst.join("proj/b.txt"), b"old").unwrap();
    std::fs::write(dst.join("proj/sub/d.txt"), b"old").unwrap();

    let remote = super::transfer::Remote(session::get_session(&state, "s").await.unwrap());
    let mut found = conflicts(&super::transfer::Local, &src.to_string_lossy(), &remote, &dst.to_string_lossy()).await.unwrap();
    found.sort();
    assert_eq!(found, vec!["b.txt", "sub/d.txt"]);

    // And a Skip on the same tree copies the other two, leaves those two.
    let summary = upload_path(&Silent, &state, "s", &src.to_string_lossy(), &dst.to_string_lossy(), Conflict::Skip).await.unwrap();
    assert_eq!((summary.files, summary.skipped_existing), (2, 2));
    assert_eq!(std::fs::read(dst.join("proj/b.txt")).unwrap(), b"old");
    assert_eq!(std::fs::read(dst.join("proj/a.txt")).unwrap(), b"x");

    // A single file that is not there is no conflict at all.
    let none = conflicts(&super::transfer::Local, &src.join("a.txt").to_string_lossy(), &remote, &server.scratch("empty").to_string_lossy()).await.unwrap();
    assert!(none.is_empty());
}

/// The edit-in-place watcher: a save on the temp copy reaches the server,
/// and the watcher stops on its own once the session is gone.
#[tokio::test]
async fn a_saved_temp_copy_is_uploaded_back() {
    let Some((server, state)) = rig("edit", None).await else { return };
    let root = server.scratch("edit");
    let remote = root.join("notes.txt");
    std::fs::write(&remote, b"before").unwrap();

    let temp = server.scratch("edit-temp").join("notes.txt");
    std::fs::write(&temp, b"before").unwrap();

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<EditEvent>();
    let tick = Duration::from_millis(50);
    let root_s = root.to_string_lossy().into_owned();
    let remote_s = remote.to_string_lossy().into_owned();
    let watcher = watch(move |e| { let _ = tx.send(e); }, &state, "s", &root_s, &remote_s, &temp, tick);

    let driver = async {
        tokio::time::sleep(tick * 2).await;
        std::fs::write(&temp, b"after the save").unwrap();

        let event = tokio::time::timeout(Duration::from_secs(5), rx.recv()).await
            .expect("an upload within five seconds")
            .expect("the watcher is still running");
        assert_eq!(event.error, None, "{:?}", event.error);
        assert_eq!(event.name, "notes.txt");
        assert_eq!(std::fs::read(&remote).unwrap(), b"after the save");

        // Session gone: the watcher notices and returns rather than polling on.
        state.sessions.lock().await.clear();
    };

    tokio::time::timeout(Duration::from_secs(10), async { tokio::join!(watcher, driver) })
        .await
        .expect("the watcher stops once the session is gone");
}

/// The quiet upload must not clear a cancel the user pressed on the
/// transfer they can see; `upload_path` does, which is why it is not used.
#[tokio::test]
async fn a_quiet_upload_leaves_a_pressed_cancel_alone() {
    let Some((server, state)) = rig("quiet", None).await else { return };
    let root = server.scratch("quiet");
    let src = root.join("f.txt");
    std::fs::write(&src, b"x").unwrap();
    let dst = server.scratch("quiet-out");

    state.request_cancel();
    upload_quiet(&state, "s", &src.to_string_lossy(), &dst.to_string_lossy()).await.unwrap();
    assert!(state.cancel.load(std::sync::atomic::Ordering::Relaxed), "the flag is still raised");
    assert_eq!(std::fs::read(dst.join("f.txt")).unwrap(), b"x", "and the upload still happened");
}

/// A listing that fails on a path is not a session that has failed. The panel
/// used to treat the two the same.
#[tokio::test]
async fn a_failed_listing_leaves_the_session_answering() {
    let Some((server, state)) = rig("probe", None).await else { return };

    let missing = server.dir.join("no-such-directory");
    assert!(list_remote(&state, "s", &missing.to_string_lossy()).await.is_err());

    assert!(probe_remote(&state, "s").await, "the session answers after a bad path");
    assert!(list_remote(&state, "s", &server.dir.to_string_lossy()).await.is_ok());
}
