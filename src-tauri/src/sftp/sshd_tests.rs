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
use super::archive::{copy_archive, download_archive, upload_archive};
use super::ops::{delete_remote, mkdir, rename_remote, set_mode_remote, set_owner_remote};
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

    state.sessions.lock().await.insert(
        id.to_string(),
        super::SftpConnection { sftp: Arc::new(Mutex::new(sftp)), opener: Arc::new(handle) },
    );
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

    let summary = download_path(&Silent, &state, "t", "s", &src.to_string_lossy(), &dst.to_string_lossy(), Conflict::Overwrite)
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

    let summary = upload_path(&Silent, &state, "t", "s", &src.to_string_lossy(), &dst.to_string_lossy(), Conflict::Overwrite)
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

/// The server's own passwd gives the listing its names, and a chown by
/// name goes through the same table. The running user chowning to itself
/// is the one chown that needs no privilege, and it must leave the bytes
/// alone; a name the server does not know must be refused before any
/// setstat, since the alternative is a setstat with a made-up id.
#[tokio::test]
async fn owners_list_by_name_and_chown_goes_through_the_same_names() {
    let Some((server, state)) = rig("chown", None).await else { return };
    let root = server.scratch("chown");
    let path = root.join("f.txt");
    std::fs::write(&path, b"hello world").unwrap();

    let me = super::owners::local_owner(unsafe { libc::getuid() }, unsafe { libc::getgid() });
    let (user, group) = me.split_once(':').unwrap();

    let entries = list_remote(&state, "s", &root.to_string_lossy()).await.unwrap();
    let f = entries.iter().find(|e| e.name == "f.txt").unwrap();
    assert_eq!(f.owner, me, "the server's /etc/passwd names the running user");
    assert_eq!(f.uid, Some(unsafe { libc::getuid() }));

    set_owner_remote(&state, "s", &path.to_string_lossy(), user, group).await.unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), b"hello world", "contents must survive a chown");

    let e = set_owner_remote(&state, "s", &path.to_string_lossy(), "no-such-user-bifrossh", group).await.unwrap_err();
    assert!(e.to_string().contains("No such user"), "{e:#}");
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
    let up = |policy| upload_path(&Silent, &state, "t", "s", &src_file, &dst_dir, policy);

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
    let summary = upload_path(&Silent, &state, "t", "s", &src.to_string_lossy(), &dst.to_string_lossy(), Conflict::Skip).await.unwrap();
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

/// The quiet upload has no place in the transfer table: nothing the user
/// can see, nothing a cancel can land on.
#[tokio::test]
async fn a_quiet_upload_is_not_in_the_transfer_table() {
    let Some((server, state)) = rig("quiet", None).await else { return };
    let root = server.scratch("quiet");
    let src = root.join("f.txt");
    std::fs::write(&src, b"x").unwrap();
    let dst = server.scratch("quiet-out");

    upload_quiet(&state, "s", &src.to_string_lossy(), &dst.to_string_lossy()).await.unwrap();
    assert!(!state.is_running("edit"), "nothing was registered");
    assert_eq!(std::fs::read(dst.join("f.txt")).unwrap(), b"x", "and the upload happened");
}

/// Each transfer has its own flag, found by id: a cancel names one and
/// leaves the others alone, and a finished transfer's id is forgotten so a
/// late cancel on it is nothing.
#[tokio::test]
async fn a_cancel_lands_on_the_transfer_it_names() {
    let Some((_server, state)) = rig("cancel-by-id", None).await else { return };
    let a = state.begin_transfer("a");
    let b = state.begin_transfer("b");
    assert!(state.is_running("a") && state.is_running("b"));

    state.request_cancel("a");
    assert!(a.cancel.load(std::sync::atomic::Ordering::Relaxed), "a was asked to stop");
    assert!(!b.cancel.load(std::sync::atomic::Ordering::Relaxed), "b was not");

    drop(a);
    assert!(!state.is_running("a"), "a's place is given back when it ends");
    state.request_cancel("a");
    assert!(!b.cancel.load(std::sync::atomic::Ordering::Relaxed), "a late cancel on a does nothing to b");
}

/// tar on the server, unpacked here: the tree that lands must be the
/// tree that left, byte for byte, and the count must match what was in
/// it. This is the whole point of the compressed path, so it is tested
/// against a real server rather than a stub.
#[tokio::test]
async fn a_compressed_download_lands_the_same_tree() {
    let Some((server, state)) = rig("archive", None).await else { return };
    let root = server.scratch("archive");
    let src = root.join("tree");
    std::fs::create_dir_all(src.join("sub")).unwrap();
    write_files(&src, 12);
    std::fs::write(src.join("sub/deep.txt"), b"deep\n").unwrap();
    // A name the server's shell would otherwise take apart.
    let odd = server.scratch("odd name's");
    std::fs::write(odd.join("f.txt"), b"odd\n").unwrap();

    let dst = server.scratch("archive-out");
    let summary = download_archive(&Silent, &state, "t", "s", &src.to_string_lossy(), &dst.to_string_lossy(), None)
        .await
        .unwrap();
    assert_eq!(summary.files, 13, "twelve files and the one in sub");
    assert!(!summary.cancelled);

    for i in 0..12 {
        let name = format!("f{i:04}.txt");
        assert_eq!(
            std::fs::read(dst.join("tree").join(&name)).unwrap(),
            std::fs::read(src.join(&name)).unwrap(),
            "{name} differs",
        );
    }
    assert_eq!(std::fs::read(dst.join("tree/sub/deep.txt")).unwrap(), b"deep\n");

    let out2 = server.scratch("archive-out2");
    download_archive(&Silent, &state, "t2", "s", &odd.to_string_lossy(), &out2.to_string_lossy(), None)
        .await
        .unwrap();
    assert_eq!(std::fs::read(out2.join("odd name's/f.txt")).unwrap(), b"odd\n");
}

/// Upwards, and then between two sessions: the same tree has to survive
/// each hop. The second session is a second connection to the same sshd,
/// which is as far as one test machine goes and exercises the same two
/// channels the real thing uses.
#[tokio::test]
async fn a_compressed_upload_and_a_server_to_server_copy_land_the_same_tree() {
    let Some((server, state)) = rig("archive-up", None).await else { return };
    let root = server.scratch("archive-up");
    let src = root.join("tree");
    std::fs::create_dir_all(src.join("sub")).unwrap();
    write_files(&src, 8);
    std::fs::write(src.join("sub/deep.txt"), b"deep\n").unwrap();

    let up = server.scratch("archive-up-out");
    upload_archive(&Silent, &state, "t", "s", &src.to_string_lossy(), &up.to_string_lossy(), None)
        .await
        .unwrap();
    assert_eq!(std::fs::read(up.join("tree/sub/deep.txt")).unwrap(), b"deep\n");
    assert_eq!(
        std::fs::read(up.join("tree/f0003.txt")).unwrap(),
        std::fs::read(src.join("f0003.txt")).unwrap(),
    );

    connect(&server, &state, "s2").await;
    let across = server.scratch("archive-across");
    copy_archive(&Silent, &state, "t2", "s", &up.join("tree").to_string_lossy(), "s2", &across.to_string_lossy(), None)
        .await
        .unwrap();
    assert_eq!(std::fs::read(across.join("tree/sub/deep.txt")).unwrap(), b"deep\n");

    // Keeping both copies: the same tree again, under another name, with
    // what was already there untouched. Every direction takes the name.
    copy_archive(&Silent, &state, "t3", "s", &up.join("tree").to_string_lossy(), "s2", &across.to_string_lossy(), Some("tree (2)"))
        .await
        .unwrap();
    assert_eq!(std::fs::read(across.join("tree (2)/sub/deep.txt")).unwrap(), b"deep\n");
    assert!(std::fs::read(across.join("tree/sub/deep.txt")).is_ok(), "the first copy is still there");
    assert!(!across.join(".bifrossh-tree (2)").exists(), "the staging directory is cleaned up");

    upload_archive(&Silent, &state, "t4", "s", &src.to_string_lossy(), &up.to_string_lossy(), Some("tree (2)"))
        .await
        .unwrap();
    assert_eq!(std::fs::read(up.join("tree (2)/sub/deep.txt")).unwrap(), b"deep\n");

    let down = server.scratch("archive-down");
    download_archive(&Silent, &state, "t5", "s", &src.to_string_lossy(), &down.to_string_lossy(), Some("tree (2)"))
        .await
        .unwrap();
    assert_eq!(std::fs::read(down.join("tree (2)/sub/deep.txt")).unwrap(), b"deep\n");
    assert!(!down.join("tree").exists(), "nothing lands under the old name");
    for i in 0..8 {
        let name = format!("f{i:04}.txt");
        assert_eq!(
            std::fs::read(across.join("tree").join(&name)).unwrap(),
            std::fs::read(src.join(&name)).unwrap(),
            "{name} differs after two hops",
        );
    }
}

/// A path the server cannot tar is the server's error, not a silent
/// empty directory.
#[tokio::test]
async fn a_compressed_download_of_nothing_reports_what_tar_said() {
    let Some((server, state)) = rig("archive-fail", None).await else { return };
    let missing = server.scratch("archive-fail").join("not-here");
    let dst = server.scratch("archive-fail-out");
    let result = download_archive(&Silent, &state, "t", "s", &missing.to_string_lossy(), &dst.to_string_lossy(), None).await;
    let shown = match result {
        Ok(_) => panic!("a directory that is not there should not have tarred"),
        Err(e) => format!("{e:#}"),
    };
    assert!(shown.contains("tar") || shown.contains("unpacked"), "{shown}");
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
