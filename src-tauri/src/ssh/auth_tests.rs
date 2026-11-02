//! End-to-end tests for the keyboard-interactive loop, driven by a real
//! russh server over a real TCP socket.
//!
//! A PAM-backed sshd needs root to set up, and the zero-prompt round that Duo
//! and PAM use for "check your phone" cannot be reproduced by hand at all
//! without a live provider. Both are exercised here instead.

use std::borrow::Cow;
use std::sync::Arc;

use async_trait::async_trait;
use russh::client::{self, Prompt};
use russh::keys::{Algorithm, PrivateKey, PublicKeyOrCertificate};
use russh::server::{self, Auth, Response};
use russh::{MethodKind, MethodSet};
use tokio::sync::Mutex;

#[cfg(unix)]
use base64::Engine as _;
#[cfg(unix)]
use russh::keys::PublicKey;

use super::auth::{keyboard_interactive, AuthPrompter};
#[cfg(unix)]
use super::auth::agent_auth;

// ── Test server ──────────────────────────────────────────────────────────────

/// One scripted round of the exchange the server will drive.
#[derive(Clone)]
struct Round {
    name: &'static str,
    instructions: &'static str,
    /// Empty means an informational round that expects an immediate empty reply.
    prompts: Vec<(&'static str, bool)>,
    /// Answers that satisfy this round. Empty means anything is accepted.
    expect: Vec<&'static str>,
}

#[derive(Clone)]
struct TestServer {
    rounds: Arc<Vec<Round>>,
    /// Rounds already issued to this client.
    issued: Arc<Mutex<usize>>,
    /// Every set of answers the client sent back.
    received: Arc<Mutex<Vec<Vec<String>>>>,
}

impl server::Server for TestServer {
    type Handler = Self;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        self.clone()
    }
}

impl server::Handler for TestServer {
    type Error = russh::Error;

    async fn auth_keyboard_interactive<'a>(
        &mut self,
        _user: &str,
        _submethods: &str,
        response: Option<Response<'a>>,
    ) -> Result<Auth, Self::Error> {
        // Record what the client answered for the round just completed.
        if let Some(response) = response {
            let answers: Vec<String> = response
                .map(|b| String::from_utf8_lossy(&b).into_owned())
                .collect();

            let index = *self.issued.lock().await;
            if let Some(round) = index.checked_sub(1).and_then(|i| self.rounds.get(i)) {
                if !round.expect.is_empty() && answers != round.expect {
                    return Ok(Auth::Reject {
                        proceed_with_methods: Some(MethodSet::from(&[MethodKind::KeyboardInteractive][..])),
                        partial_success: false,
                    });
                }
            }
            self.received.lock().await.push(answers);
        }

        let mut issued = self.issued.lock().await;
        match self.rounds.get(*issued) {
            Some(round) => {
                *issued += 1;
                Ok(Auth::Partial {
                    name: Cow::Borrowed(round.name),
                    instructions: Cow::Borrowed(round.instructions),
                    prompts: Cow::Owned(
                        round
                            .prompts
                            .iter()
                            .map(|(p, echo)| (Cow::Borrowed(*p), *echo))
                            .collect::<Vec<_>>(),
                    ),
                })
            }
            None => Ok(Auth::Accept),
        }
    }
}

/// Boots the scripted server on an ephemeral port. Returns the port plus the
/// record of what the client answered.
async fn spawn_server(rounds: Vec<Round>) -> (u16, Arc<Mutex<Vec<Vec<String>>>>) {
    let received = Arc::new(Mutex::new(Vec::new()));
    let server = TestServer {
        rounds: Arc::new(rounds),
        issued: Arc::new(Mutex::new(0)),
        received: Arc::clone(&received),
    };

    let config = Arc::new(server::Config {
        keys: vec![host_key()],
        methods: MethodSet::from(&[MethodKind::KeyboardInteractive][..]),
        ..Default::default()
    });

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();

    tokio::spawn(async move {
        if let Ok((stream, _)) = listener.accept().await {
            let mut server = server.clone();
            let handler = server::Server::new_client(&mut server, None);
            let _ = server::run_stream(config, stream, handler).await;
        }
    });

    (port, received)
}

/// A throwaway host key for a test server.
fn host_key() -> PrivateKey {
    PrivateKey::random(&mut russh::keys::key::safe_rng(), Algorithm::Ed25519).unwrap()
}

// ── Test client ──────────────────────────────────────────────────────────────

struct AcceptAnyKey;

impl client::Handler for AcceptAnyKey {
    type Error = russh::Error;
    async fn check_server_key(&mut self, _: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        Ok(true) // host key verification is covered by the hostkeys tests
    }
}

/// Stands in for the user. Records what it was asked and replies from a script.
/// One recorded prompt round: name, instruction, and each prompt with its echo flag.
type AskedRound = (String, String, Vec<(String, bool)>);

struct MockPrompter {
    answers: Vec<Vec<String>>,
    /// `true` makes every round come back as a cancellation.
    cancel: bool,
    interactive: bool,
    asked: Mutex<Vec<AskedRound>>,
    calls: Mutex<usize>,
}

impl MockPrompter {
    fn new(answers: Vec<Vec<&str>>) -> Self {
        MockPrompter {
            answers: answers
                .into_iter()
                .map(|a| a.into_iter().map(String::from).collect())
                .collect(),
            cancel: false,
            interactive: true,
            asked: Mutex::new(Vec::new()),
            calls: Mutex::new(0),
        }
    }
}

#[async_trait]
impl AuthPrompter for MockPrompter {
    fn interactive(&self) -> bool {
        self.interactive
    }

    fn log(&self, _kind: &str, _message: &str) {}

    async fn ask(&self, name: &str, instructions: &str, prompts: &[Prompt]) -> Option<Vec<String>> {
        self.asked.lock().await.push((
            name.to_string(),
            instructions.to_string(),
            prompts.iter().map(|p| (p.prompt.clone(), p.echo)).collect(),
        ));
        let mut calls = self.calls.lock().await;
        let index = *calls;
        *calls += 1;

        if self.cancel {
            return None;
        }
        self.answers.get(index).cloned()
    }
}

async fn connect(port: u16) -> client::Handle<AcceptAnyKey> {
    let config = Arc::new(client::Config::default());
    client::connect(config, ("127.0.0.1", port), AcceptAnyKey)
        .await
        .expect("client should connect to the test server")
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn two_prompt_round_succeeds() {
    let (port, received) = spawn_server(vec![Round {
        name: "PAM authentication",
        instructions: "Enter your credentials",
        prompts: vec![("Password: ", false), ("Verification code: ", true)],
        expect: vec!["hunter2", "123456"],
    }])
    .await;

    let prompter = MockPrompter::new(vec![vec!["hunter2", "123456"]]);
    let mut handle = connect(port).await;

    let ok = keyboard_interactive(&mut handle, "tester", &prompter)
        .await
        .unwrap();

    assert!(ok, "correct answers should authenticate");
    assert_eq!(received.lock().await.as_slice(), &[vec!["hunter2", "123456"]]);

    // The server's wording and echo flags must reach the UI verbatim: a
    // password field rendered with echo on would show the secret.
    let asked = prompter.asked.lock().await;
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0].0, "PAM authentication");
    assert_eq!(asked[0].1, "Enter your credentials");
    assert_eq!(
        asked[0].2,
        vec![
            ("Password: ".to_string(), false),
            ("Verification code: ".to_string(), true),
        ]
    );
}

/// The case that hangs naive implementations: a round with no prompts is the
/// server talking, not asking, and must be answered immediately without a modal.
#[tokio::test]
async fn zero_prompt_round_answers_without_asking_the_user() {
    let (port, received) = spawn_server(vec![
        Round {
            name: "Duo two-factor",
            instructions: "Pushed a login request to your phone...",
            prompts: vec![],
            expect: vec![],
        },
        Round {
            name: "",
            instructions: "",
            prompts: vec![("Password: ", false)],
            expect: vec!["hunter2"],
        },
    ])
    .await;

    let prompter = MockPrompter::new(vec![vec!["hunter2"]]);
    let mut handle = connect(port).await;

    let ok = keyboard_interactive(&mut handle, "tester", &prompter)
        .await
        .unwrap();

    assert!(ok);
    assert_eq!(
        prompter.asked.lock().await.len(),
        1,
        "the informational round must not raise a prompt"
    );
    let received = received.lock().await;
    assert_eq!(received[0], Vec::<String>::new(), "empty reply sent immediately");
    assert_eq!(received[1], vec!["hunter2"]);
}

#[tokio::test]
async fn cancelling_a_prompt_fails_authentication() {
    let (port, _) = spawn_server(vec![Round {
        name: "PAM",
        instructions: "",
        prompts: vec![("Password: ", false)],
        expect: vec![],
    }])
    .await;

    let mut prompter = MockPrompter::new(vec![]);
    prompter.cancel = true;
    let mut handle = connect(port).await;

    let ok = keyboard_interactive(&mut handle, "tester", &prompter)
        .await
        .unwrap();

    assert!(!ok, "cancelling must not authenticate");
}

/// Background connects (OS detection) have no UI, so they must fail rather
/// than block forever waiting on a prompt nobody can answer.
#[tokio::test]
async fn non_interactive_refuses_to_prompt() {
    let (port, _) = spawn_server(vec![Round {
        name: "PAM",
        instructions: "",
        prompts: vec![("Password: ", false)],
        expect: vec![],
    }])
    .await;

    let mut prompter = MockPrompter::new(vec![vec!["hunter2"]]);
    prompter.interactive = false;
    let mut handle = connect(port).await;

    let ok = keyboard_interactive(&mut handle, "tester", &prompter)
        .await
        .unwrap();

    assert!(!ok);
    assert_eq!(
        prompter.asked.lock().await.len(),
        0,
        "must not prompt when there is no UI"
    );
}

#[tokio::test]
async fn wrong_answer_is_rejected() {
    let (port, _) = spawn_server(vec![Round {
        name: "PAM",
        instructions: "",
        prompts: vec![("Password: ", false)],
        expect: vec!["correct-horse"],
    }])
    .await;

    let prompter = MockPrompter::new(vec![vec!["wrong"]]);
    let mut handle = connect(port).await;

    let ok = keyboard_interactive(&mut handle, "tester", &prompter)
        .await
        .unwrap();

    assert!(!ok, "a wrong answer must not authenticate");
}

/// A server that never stops asking must not loop forever.
#[tokio::test]
async fn endless_prompts_are_capped() {
    let rounds: Vec<Round> = (0..40)
        .map(|_| Round {
            name: "PAM",
            instructions: "",
            prompts: vec![("Again: ", false)],
            expect: vec![],
        })
        .collect();
    let (port, _) = spawn_server(rounds).await;

    let prompter = MockPrompter::new(vec![vec!["x"]; 40]);
    let mut handle = connect(port).await;

    let result = keyboard_interactive(&mut handle, "tester", &prompter).await;

    assert!(result.is_err(), "the loop must give up");
    assert!(
        prompter.asked.lock().await.len() <= 20,
        "must stop at the round cap"
    );
}

// ── ssh-agent authentication ─────────────────────────────────────────────────
//
// Unix only: these boot a real `ssh-agent` over a real Unix socket and stop it
// again with `kill`. The Windows agent is a named pipe behind a service, which
// a test cannot stand up and tear down the same way.

#[cfg(unix)]
/// A server that accepts exactly one public key, by blob comparison.
#[derive(Clone)]
struct PubkeyServer {
    accepted: Arc<Vec<u8>>,
    offered: Arc<Mutex<Vec<String>>>,
}

#[cfg(unix)]
impl server::Server for PubkeyServer {
    type Handler = Self;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        self.clone()
    }
}

#[cfg(unix)]
impl server::Handler for PubkeyServer {
    type Error = russh::Error;

    async fn auth_publickey(
        &mut self,
        _user: &str,
        key: &PublicKey,
    ) -> Result<Auth, Self::Error> {
        let blob = crate::hostkeys::blob(key);
        self.offered.lock().await.push(hex(&blob));
        if blob == *self.accepted {
            Ok(Auth::Accept)
        } else {
            Ok(Auth::reject())
        }
    }
}

#[cfg(unix)]
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

#[cfg(unix)]
async fn spawn_pubkey_server(accepted: Vec<u8>) -> (u16, Arc<Mutex<Vec<String>>>) {
    let offered = Arc::new(Mutex::new(Vec::new()));
    let server = PubkeyServer {
        accepted: Arc::new(accepted),
        offered: Arc::clone(&offered),
    };

    let config = Arc::new(server::Config {
        keys: vec![host_key()],
        methods: MethodSet::from(&[MethodKind::PublicKey][..]),
        ..Default::default()
    });

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();

    tokio::spawn(async move {
        if let Ok((stream, _)) = listener.accept().await {
            let mut server = server.clone();
            let handler = server::Server::new_client(&mut server, None);
            let _ = server::run_stream(config, stream, handler).await;
        }
    });

    (port, offered)
}

#[cfg(unix)]
/// Boots a real `ssh-agent` and loads the given keys into it.
/// Returns the socket path plus the public key blob of each loaded key.
fn spawn_ssh_agent(count: usize) -> Option<(std::path::PathBuf, Vec<Vec<u8>>, AgentGuard)> {
    use std::process::Command;

    let dir = std::env::temp_dir().join(format!("bifrossh-sshagent-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).ok()?;
    let sock = dir.join("agent.sock");

    let out = Command::new("ssh-agent").args(["-a"]).arg(&sock).output().ok()?;
    if !out.status.success() {
        return None;
    }

    // ssh-agent daemonises and prints `SSH_AGENT_PID=NNN; export ...`. The pid
    // is the only reliable way to stop it again: `ssh-agent -k` needs
    // SSH_AGENT_PID and silently leaves the process running without it.
    let stdout = String::from_utf8_lossy(&out.stdout);
    let pid: u32 = stdout
        .split("SSH_AGENT_PID=")
        .nth(1)?
        .split(|c: char| !c.is_ascii_digit())
        .next()?
        .parse()
        .ok()?;
    let guard = AgentGuard { pid, dir: dir.clone() };

    let mut blobs = Vec::new();
    for i in 0..count {
        let key_path = dir.join(format!("id{}", i));
        let ok = Command::new("ssh-keygen")
            .args(["-q", "-t", "ed25519", "-N", "", "-C", "", "-f"])
            .arg(&key_path)
            .status()
            .ok()?
            .success();
        if !ok {
            return None;
        }
        let added = Command::new("ssh-add")
            .env("SSH_AUTH_SOCK", &sock)
            .arg(&key_path)
            .status()
            .ok()?
            .success();
        if !added {
            return None;
        }

        let pubtext = std::fs::read_to_string(key_path.with_extension("pub")).ok()?;
        let b64 = pubtext.split_whitespace().nth(1)?;
        blobs.push(
            base64::engine::general_purpose::STANDARD
                .decode(b64)
                .ok()?,
        );
    }

    Some((sock, blobs, guard))
}

#[cfg(unix)]
/// Stops the agent and removes its directory when the test ends, so a test run
/// does not leave stray agents on the machine.
struct AgentGuard {
    pid: u32,
    dir: std::path::PathBuf,
}

#[cfg(unix)]
impl Drop for AgentGuard {
    fn drop(&mut self) {
        let _ = std::process::Command::new("kill")
            .arg(self.pid.to_string())
            .output();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[cfg(unix)]
struct SilentPrompter;

#[cfg(unix)]
#[async_trait]
impl AuthPrompter for SilentPrompter {
    fn interactive(&self) -> bool { true }
    fn log(&self, _kind: &str, _message: &str) {}
    async fn ask(&self, _: &str, _: &str, _: &[Prompt]) -> Option<Vec<String>> { None }
}

#[cfg(unix)]
/// Exercises the agent path against a real `ssh-agent` and a real server.
///
/// Both halves live in one test on purpose: they mutate SSH_AUTH_SOCK, which is
/// process-wide, so running them as separate tests races under the parallel
/// harness.
#[tokio::test]
async fn agent_authentication() {
    // A missing socket must be a clear error rather than a silent failure.
    std::env::set_var("SSH_AUTH_SOCK", "/nonexistent/bifrossh-agent.sock");
    {
        let (port, _) = spawn_pubkey_server(vec![0u8; 4]).await;
        let mut handle = connect(port).await;
        let err = agent_auth(&mut handle, "tester", None, &SilentPrompter)
            .await
            .expect_err("a missing agent socket must be an error");
        assert!(
            err.to_string().contains("ssh-agent"),
            "the error should name ssh-agent, got: {err}"
        );
    }

    let Some((sock, blobs, _guard)) = spawn_ssh_agent(3) else {
        eprintln!("skipping the live-agent half: ssh-agent/ssh-keygen unavailable");
        return;
    };
    std::env::set_var("SSH_AUTH_SOCK", &sock);

    // Only the last of the three loaded keys is authorised, so this passes only
    // if the signer is handed back and reused across iterations.
    let accepted = blobs.last().unwrap().clone();
    {
        let (port, offered) = spawn_pubkey_server(accepted.clone()).await;
        let mut handle = connect(port).await;
        let ok = agent_auth(&mut handle, "tester", None, &SilentPrompter)
            .await
            .unwrap();
        assert!(ok.success(), "one of the agent's keys is authorised, so auth must succeed");
        assert!(!offered.lock().await.is_empty(), "the server saw keys offered");
    }

    // Pinning a fingerprint the agent does not hold must say so, rather than
    // quietly trying every other key.
    {
        let (port, _) = spawn_pubkey_server(accepted.clone()).await;
        let mut handle = connect(port).await;
        let err = agent_auth(
            &mut handle,
            "tester",
            Some("SHA256:definitelyNotAKeyInTheAgent00000000000000"),
            &SilentPrompter,
        )
        .await
        .expect_err("a pinned key that is absent must be reported");
        assert!(
            err.to_string().contains("no longer in ssh-agent"),
            "unexpected error: {err}"
        );
    }

    // A FIDO security key held by the agent, judged by real OpenSSH. Here
    // rather than in a test of its own because it points SSH_AUTH_SOCK
    // somewhere else too.
    let Some(sshd) = spawn_sshd_for_sk() else {
        eprintln!("skipping the FIDO half: sshd unavailable");
        return;
    };
    std::env::set_var("SSH_AUTH_SOCK", &sshd.agent_sock);
    let mut handle = connect(sshd.port).await;
    let ok = agent_auth(&mut handle, &sshd.user, None, &SilentPrompter)
        .await
        .unwrap();
    assert!(
        ok.success(),
        "sshd must accept a security-key signature made through the agent; its log:\n{}",
        std::fs::read_to_string(sshd.dir.join("sshd.log")).unwrap_or_default()
    );
}

// ── A FIDO key, without the hardware ─────────────────────────────────────────
//
// A security key signs `sha256(application) || flags || counter ||
// sha256(data)` with an ordinary Ed25519 key, and the agent hands back that
// signature with the flags and counter after it. A key we hold ourselves can
// do the same arithmetic, so a fake agent can stand in for a YubiKey and a
// real sshd can judge the result.

#[cfg(unix)]
const SK_ED25519: &str = "sk-ssh-ed25519@openssh.com";
#[cfg(unix)]
const SK_APPLICATION: &str = "ssh:";

#[cfg(unix)]
fn sk_push_string(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(bytes);
}

#[cfg(unix)]
fn sk_read_string(buf: &[u8], at: &mut usize) -> Option<Vec<u8>> {
    let len = u32::from_be_bytes(buf.get(*at..*at + 4)?.try_into().ok()?) as usize;
    let out = buf.get(*at + 4..*at + 4 + len)?.to_vec();
    *at += 4 + len;
    Some(out)
}

/// Serves REQUEST_IDENTITIES and SIGN_REQUEST for one security key, on as
/// many connections and requests as come.
#[cfg(unix)]
fn spawn_sk_agent(sock: &std::path::Path, key: PrivateKey, blob: Vec<u8>) {
    use sha2::{Digest, Sha256};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::UnixListener::bind(sock).unwrap();
    let key = Arc::new(key);
    tokio::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let key = Arc::clone(&key);
            let blob = blob.clone();
            tokio::spawn(async move {
                loop {
                    let mut len = [0u8; 4];
                    if stream.read_exact(&mut len).await.is_err() {
                        return;
                    }
                    let mut req = vec![0u8; u32::from_be_bytes(len) as usize];
                    if stream.read_exact(&mut req).await.is_err() {
                        return;
                    }
                    let body = match req.first() {
                        Some(11) => {
                            let mut body = vec![12];
                            body.extend_from_slice(&1u32.to_be_bytes());
                            sk_push_string(&mut body, &blob);
                            sk_push_string(&mut body, b"fido@test");
                            body
                        }
                        Some(13) => {
                            let mut at = 1;
                            let _key_blob = sk_read_string(&req, &mut at);
                            let Some(data) = sk_read_string(&req, &mut at) else { return };
                            let (flags, counter) = (0x01u8, 7u32);
                            let mut signed = Sha256::digest(SK_APPLICATION.as_bytes()).to_vec();
                            signed.push(flags);
                            signed.extend_from_slice(&counter.to_be_bytes());
                            signed.extend_from_slice(&Sha256::digest(&data));
                            let sig: russh::keys::ssh_key::Signature =
                                russh::keys::signature::Signer::sign(key.as_ref(), &signed);
                            let mut signature = Vec::new();
                            sk_push_string(&mut signature, SK_ED25519.as_bytes());
                            sk_push_string(&mut signature, sig.as_bytes());
                            signature.push(flags);
                            signature.extend_from_slice(&counter.to_be_bytes());
                            let mut body = vec![14];
                            sk_push_string(&mut body, &signature);
                            body
                        }
                        _ => vec![5], // SSH_AGENT_FAILURE
                    };
                    let mut out = (body.len() as u32).to_be_bytes().to_vec();
                    out.extend_from_slice(&body);
                    if stream.write_all(&out).await.is_err() {
                        return;
                    }
                }
            });
        }
    });
}

/// An sshd run as the current user on a free port, whose only authorised
/// key is a security key held by a fake agent.
#[cfg(unix)]
struct SkSshd {
    port: u16,
    user: String,
    agent_sock: std::path::PathBuf,
    dir: std::path::PathBuf,
    child: std::process::Child,
}

#[cfg(unix)]
impl Drop for SkSshd {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

#[cfg(unix)]
fn spawn_sshd_for_sk() -> Option<SkSshd> {
    use std::process::{Command, Stdio};
    let sshd = ["/usr/sbin/sshd", "/usr/bin/sshd"].into_iter().find(|p| std::path::Path::new(p).exists())?;
    let user = std::env::var("USER").ok()?;

    let dir = std::env::temp_dir().join(format!("bifrossh-sk-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).ok()?;
    let host_key = dir.join("host_key");
    let made = Command::new("ssh-keygen")
        .args(["-q", "-t", "ed25519", "-N", "", "-f"])
        .arg(&host_key)
        .status()
        .ok()?
        .success();
    if !made {
        return None;
    }

    // The security key's public half, as an authorized_keys line.
    let key = PrivateKey::random(&mut russh::keys::key::safe_rng(), Algorithm::Ed25519).ok()?;
    let ed = key.public_key().key_data().ed25519()?.0;
    let mut blob = Vec::new();
    sk_push_string(&mut blob, SK_ED25519.as_bytes());
    sk_push_string(&mut blob, &ed);
    sk_push_string(&mut blob, SK_APPLICATION.as_bytes());
    let line = format!("{} {}\n", SK_ED25519, base64::engine::general_purpose::STANDARD.encode(&blob));
    std::fs::write(dir.join("authorized_keys"), line).ok()?;

    let port = std::net::TcpListener::bind(("127.0.0.1", 0)).ok()?.local_addr().ok()?.port();
    let config = format!(
        "Port {port}\nListenAddress 127.0.0.1\nHostKey {}\nPidFile none\nAuthorizedKeysFile {}\n\
         StrictModes no\nUsePAM no\nPasswordAuthentication no\nKbdInteractiveAuthentication no\n\
         LogLevel VERBOSE\n",
        host_key.display(),
        dir.join("authorized_keys").display(),
    );
    std::fs::write(dir.join("sshd_config"), config).ok()?;
    let log = std::fs::File::create(dir.join("sshd.log")).ok()?;
    let child = Command::new(sshd)
        .arg("-D").arg("-e").arg("-f").arg(dir.join("sshd_config"))
        .stdout(Stdio::null())
        .stderr(log)
        .spawn()
        .ok()?;

    let agent_sock = dir.join("agent.sock");
    spawn_sk_agent(&agent_sock, key, blob);

    let started = std::time::Instant::now();
    while std::net::TcpStream::connect(("127.0.0.1", port)).is_err() {
        if started.elapsed() > std::time::Duration::from_secs(5) {
            eprintln!("sshd did not start: {}", std::fs::read_to_string(dir.join("sshd.log")).unwrap_or_default());
            return None;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    Some(SkSshd { port, user, agent_sock, dir, child })
}
