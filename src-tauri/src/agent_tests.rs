//! Tests for the local russh-keys patch that makes ssh-agent listings tolerate
//! identities the crate cannot parse.
//!
//! Upstream `request_identities` does `parse_public_key(..)?`, so one
//! unsupported key aborts the entire listing. Agents commonly hold FIDO
//! security-key identities (`sk-ssh-ed25519@openssh.com`), which russh-keys
//! 0.44 has no support for, and one of those would otherwise make every other
//! key in the agent unusable.
//!
//! These drive a fake agent over a real Unix socket, so they exercise the
//! patched parsing path rather than mocking it.

use russh_keys::agent::client::AgentClient;
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
    use russh_keys::PublicKeyBase64;
    russh_keys::key::KeyPair::generate_ed25519()
        .unwrap()
        .public_key_bytes()
}

/// A FIDO security-key blob, which russh-keys cannot parse:
/// string(algorithm) + string(key) + string(application).
fn sk_ed25519_blob() -> Vec<u8> {
    let mut blob = Vec::new();
    push_string(&mut blob, b"sk-ssh-ed25519@openssh.com");
    push_string(&mut blob, &[0xAB; 32]);
    push_string(&mut blob, b"ssh:");
    blob
}

/// Serves exactly one REQUEST_IDENTITIES with the given (blob, comment) pairs.
async fn spawn_agent(identities: Vec<(Vec<u8>, &'static str)>) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "bifrossh-agent-{}-{:?}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
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

    path
}

#[tokio::test]
async fn parseable_identities_are_returned() {
    let path = spawn_agent(vec![
        (ed25519_blob(), "one@host"),
        (ed25519_blob(), "two@host"),
    ])
    .await;

    let mut agent = AgentClient::connect_uds(&path).await.unwrap();
    let keys = agent.request_identities().await.unwrap();

    assert_eq!(keys.len(), 2);
    assert!(keys.iter().all(|k| k.name() == "ssh-ed25519"));
}

/// The whole point of the patch: upstream returns Err here and the user loses
/// access to every key in their agent.
#[tokio::test]
async fn a_fido_key_does_not_hide_the_others() {
    let path = spawn_agent(vec![
        (sk_ed25519_blob(), "yubikey"),
        (ed25519_blob(), "usable@host"),
    ])
    .await;

    let mut agent = AgentClient::connect_uds(&path).await.unwrap();
    let keys = agent
        .request_identities()
        .await
        .expect("an unsupported identity must not fail the listing");

    assert_eq!(keys.len(), 1, "the FIDO key is skipped, the other survives");
    assert_eq!(keys[0].name(), "ssh-ed25519");
}

/// A FIDO key listed last must not truncate the ones before it either, which
/// only holds if the reader stays in sync across the skipped entry.
#[tokio::test]
async fn skipping_keeps_the_reader_aligned() {
    let path = spawn_agent(vec![
        (ed25519_blob(), "first"),
        (sk_ed25519_blob(), "yubikey"),
        (ed25519_blob(), "third"),
    ])
    .await;

    let mut agent = AgentClient::connect_uds(&path).await.unwrap();
    let keys = agent.request_identities().await.unwrap();

    assert_eq!(keys.len(), 2, "both ordinary keys decode around the skip");
}

#[tokio::test]
async fn an_empty_agent_is_not_an_error() {
    let path = spawn_agent(vec![]).await;

    let mut agent = AgentClient::connect_uds(&path).await.unwrap();
    let keys = agent.request_identities().await.unwrap();

    assert!(keys.is_empty());
}
