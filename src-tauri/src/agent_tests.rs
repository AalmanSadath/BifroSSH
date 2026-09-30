//! ssh-agent listings with identities of every kind.
//!
//! Agents commonly hold FIDO security-key identities
//! (`sk-ssh-ed25519@openssh.com`) beside ordinary keys, and russh 0.44 could
//! not parse them: one aborted the whole listing, and a vendored patch made it
//! skip them. The ssh-key russh now uses reads them, and reads a type it does
//! not know as an opaque key, so every identity is listed and none hides the
//! others. These pin that down.
//!
//! They drive a fake agent over a real Unix socket, so they exercise the real
//! parsing path rather than mocking it.

use russh::keys::agent::client::AgentClient;
use russh::keys::agent::AgentIdentity;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const REQUEST_IDENTITIES: u8 = 11;
const IDENTITIES_ANSWER: u8 = 12;

fn push_string(out: &mut Vec<u8>, bytes: &[u8]) {
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(bytes);
}

/// An ordinary ed25519 public key blob.
///
/// Generated rather than hand-assembled: ed25519 validates that the key is a
/// real curve point, so arbitrary bytes would be rejected as unparseable and
/// the test would pass for the wrong reason.
fn ed25519_blob() -> Vec<u8> {
    use russh::keys::{Algorithm, PrivateKey};
    PrivateKey::random(&mut russh::keys::key::safe_rng(), Algorithm::Ed25519)
        .unwrap()
        .public_key()
        .to_bytes()
        .unwrap()
}

/// A key type no library knows: string(algorithm) + string(opaque key).
fn unknown_blob() -> Vec<u8> {
    let mut blob = Vec::new();
    push_string(&mut blob, b"ssh-future@example.com");
    push_string(&mut blob, &[0x42; 16]);
    blob
}

/// The algorithm an identity lists as.
fn algorithm(identity: &AgentIdentity) -> String {
    crate::ssh::identity_key(identity).algorithm().as_str().to_string()
}

/// A FIDO security-key blob:
/// string(algorithm) + string(key) + string(application).
fn sk_ed25519_blob() -> Vec<u8> {
    let mut blob = Vec::new();
    push_string(&mut blob, b"sk-ssh-ed25519@openssh.com");
    push_string(&mut blob, &[0xAB; 32]);
    push_string(&mut blob, b"ssh:");
    blob
}

/// Removes the socket directory when the test ends, so a test run does not
/// litter /tmp.
struct SocketDirGuard(std::path::PathBuf);

impl Drop for SocketDirGuard {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Serves exactly one REQUEST_IDENTITIES with the given (blob, comment) pairs.
async fn spawn_agent(
    identities: Vec<(Vec<u8>, &'static str)>,
) -> (std::path::PathBuf, SocketDirGuard) {
    // A counter rather than a timestamp: these tests run in parallel and two
    // of them starting within the same nanosecond would share a directory,
    // leaving the second to fail binding the socket with AddrInUse.
    static NEXT_ID: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    let id = NEXT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);

    let dir = std::env::temp_dir().join(format!(
        "bifrossh-agent-{}-{}",
        std::process::id(),
        id
    ));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("agent.sock");

    let listener = tokio::net::UnixListener::bind(&path).unwrap();

    tokio::spawn(async move {
        let Ok((mut stream, _)) = listener.accept().await else { return };

        // Request: length-prefixed, first byte is the message type.
        let mut len = [0u8; 4];
        if stream.read_exact(&mut len).await.is_err() {
            return;
        }
        let mut req = vec![0u8; u32::from_be_bytes(len) as usize];
        if stream.read_exact(&mut req).await.is_err() {
            return;
        }
        if req.first() != Some(&REQUEST_IDENTITIES) {
            return;
        }

        let mut body = vec![IDENTITIES_ANSWER];
        body.extend_from_slice(&(identities.len() as u32).to_be_bytes());
        for (blob, comment) in &identities {
            push_string(&mut body, blob);
            push_string(&mut body, comment.as_bytes());
        }

        let mut out = (body.len() as u32).to_be_bytes().to_vec();
        out.extend_from_slice(&body);
        let _ = stream.write_all(&out).await;
        let _ = stream.flush().await;
    });

    (path, SocketDirGuard(dir))
}

#[tokio::test]
async fn ordinary_identities_are_returned() {
    let (path, _guard) = spawn_agent(vec![
        (ed25519_blob(), "one@host"),
        (ed25519_blob(), "two@host"),
    ])
    .await;

    let mut agent = AgentClient::connect_uds(&path).await.unwrap();
    let keys = agent.request_identities().await.unwrap();

    assert_eq!(keys.len(), 2);
    assert!(keys.iter().all(|k| algorithm(k) == "ssh-ed25519"));
}

/// What the old patch was for: a FIDO key must not cost the user every other
/// key in their agent. It is now listed too, as what it is.
#[tokio::test]
async fn a_fido_key_is_listed_beside_the_others() {
    let (path, _guard) = spawn_agent(vec![
        (sk_ed25519_blob(), "yubikey"),
        (ed25519_blob(), "usable@host"),
    ])
    .await;

    let mut agent = AgentClient::connect_uds(&path).await.unwrap();
    let keys = agent
        .request_identities()
        .await
        .expect("a FIDO identity must not fail the listing");

    assert_eq!(keys.len(), 2);
    assert_eq!(algorithm(&keys[0]), "sk-ssh-ed25519@openssh.com");
    assert_eq!(algorithm(&keys[1]), "ssh-ed25519");
}

/// A type nothing here knows is listed rather than failing the listing, and
/// the reader stays in step across it.
#[tokio::test]
async fn an_unknown_key_type_does_not_hide_the_others() {
    let (path, _guard) = spawn_agent(vec![
        (ed25519_blob(), "first"),
        (unknown_blob(), "future"),
        (ed25519_blob(), "third"),
    ])
    .await;

    let mut agent = AgentClient::connect_uds(&path).await.unwrap();
    let keys = agent.request_identities().await.unwrap();

    assert_eq!(keys.len(), 3);
    assert_eq!(algorithm(&keys[2]), "ssh-ed25519");
}

#[tokio::test]
async fn an_empty_agent_is_not_an_error() {
    let (path, _guard) = spawn_agent(vec![]).await;

    let mut agent = AgentClient::connect_uds(&path).await.unwrap();
    let keys = agent.request_identities().await.unwrap();

    assert!(keys.is_empty());
}
