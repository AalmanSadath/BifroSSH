//! Where the master key lives.
//!
//! Everything sensitive in data.json is encrypted with one 32 byte key. That
//! key used to sit in a file beside the data it protects, which meant anything
//! copying the data copied the key with it: a home directory backup, a synced
//! folder, a tarball mailed to yourself. Encryption that travels with its own
//! key is obfuscation.
//!
//! So the key is put in the desktop keyring where there is one. The key itself
//! never changes, because changing it would mean re-encrypting every stored
//! credential and any interruption during that would lose them. Instead it is
//! wrapped once per available mechanism and the wrapped copies are kept in
//! keystore.json. A mechanism can then be added or taken away by rewriting one
//! small file.
//!
//! Nothing here protects a secret from another process running as the same
//! user, because on Linux nothing can: the Secret Service has no per
//! application access control for host processes. What it does buy is that the
//! key is no longer in the file tree, so copying the data no longer copies the
//! key, and inside Flatpak the portal scopes the secret to this application id
//! so other sandboxed apps get a different one.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::crypto;

pub const KEYSTORE_FILE: &str = "keystore.json";
pub const SECRET_FILE: &str = ".secret";

/// The application id, which is what the Secret portal scopes its secret to
/// and what names the Secret Service item.
const APP_ID: &str = "io.github.aalmansadath.bifrossh";

/// A keyring that is present but locked will sit waiting for a prompter that,
/// under a bare window manager, may not exist. Startup must not hang on that.
const KEYRING_TIMEOUT: Duration = Duration::from_secs(5);

/// How the master key was obtained, so the UI can say so rather than implying
/// a protection that is not in place.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum KeySource {
    /// Unwrapped with a key encryption key held by the desktop keyring.
    Keyring,
    /// Read from .secret, which sits beside the data it protects.
    File,
    /// Unwrapped with a key derived from a passphrase the user typed.
    Passphrase,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct KeyStore {
    pub version: u32,
    /// Master key wrapped with the keyring held key encryption key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keyring: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub passphrase: Option<PassphraseWrapper>,
}

/// Argon2id parameters are stored alongside the wrapped key rather than being
/// assumed, so raising them later cannot lock anyone out of data written with
/// the old ones.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PassphraseWrapper {
    pub salt: String,
    pub m_cost: u32,
    pub t_cost: u32,
    pub p_cost: u32,
    pub blob: String,
}

// ── Envelope ────────────────────────────────────────────────────────────────

pub fn wrap(master: &[u8; 32], kek: &[u8; 32]) -> Result<String> {
    crypto::encrypt(master, kek)
}

pub fn unwrap_key(blob: &str, kek: &[u8; 32]) -> Result<[u8; 32]> {
    let bytes = crypto::decrypt(blob, kek)?;
    let slice: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| anyhow!("Wrapped master key is {} bytes, expected 32", bytes.len()))?;
    Ok(slice)
}

/// The keyring hands back an opaque blob of whatever length it likes (the
/// portal returns 64 bytes here), so it is hashed down to a key rather than
/// being used raw.
fn kek_from_secret(secret: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"bifrossh-master-key-wrap-v1");
    hasher.update(secret);
    hasher.finalize().into()
}

pub fn derive_passphrase_kek(passphrase: &str, w: &PassphraseWrapper) -> Result<[u8; 32]> {
    use argon2::{Algorithm, Argon2, Params, Version};
    let salt = BASE64.decode(&w.salt)?;
    let params = Params::new(w.m_cost, w.t_cost, w.p_cost, Some(32))
        .map_err(|e| anyhow!("Bad Argon2 parameters: {e}"))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut kek = [0u8; 32];
    argon
        .hash_password_into(passphrase.as_bytes(), &salt, &mut kek)
        .map_err(|e| anyhow!("Could not derive key from passphrase: {e}"))?;
    Ok(kek)
}

/// OWASP's second recommended Argon2id profile: 19 MiB, 2 passes. Chosen over
/// the heavier ones because this runs on the UI thread at unlock.
pub fn new_passphrase_wrapper(passphrase: &str, master: &[u8; 32]) -> Result<PassphraseWrapper> {
    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let mut wrapper = PassphraseWrapper {
        salt: BASE64.encode(salt),
        m_cost: 19 * 1024,
        t_cost: 2,
        p_cost: 1,
        blob: String::new(),
    };
    let kek = derive_passphrase_kek(passphrase, &wrapper)?;
    wrapper.blob = wrap(master, &kek)?;
    Ok(wrapper)
}

// ── Keystore file ───────────────────────────────────────────────────────────

pub fn load_keystore(dir: &Path) -> Result<KeyStore> {
    let path = dir.join(KEYSTORE_FILE);
    if !path.exists() {
        return Ok(KeyStore { version: 1, ..Default::default() });
    }
    let text = std::fs::read_to_string(&path)
        .with_context(|| format!("reading {}", path.display()))?;
    serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))
}

pub fn save_keystore(dir: &Path, store: &KeyStore) -> Result<()> {
    crate::store::write_private(&dir.join(KEYSTORE_FILE), serde_json::to_string_pretty(store)?.as_bytes())
}

// ── Keyring ─────────────────────────────────────────────────────────────────

/// Inside Flatpak the portal is the right door: it hands out a secret scoped
/// to this application id, so other sandboxed apps cannot ask for ours. On the
/// host the portal has no application id to scope by and returns the same
/// secret to every unsandboxed caller, so the Secret Service is used directly
/// there instead, with an item of our own.
fn in_flatpak() -> bool {
    Path::new("/.flatpak-info").exists()
}

/// Runs `f` on a scratch thread so a keyring that never answers cannot hold up
/// startup. A timed out thread is left behind blocked on D-Bus; it holds
/// nothing the rest of the app needs and dies with the process.
fn with_timeout<T: Send + 'static>(f: impl FnOnce() -> T + Send + 'static) -> Option<T> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    rx.recv_timeout(KEYRING_TIMEOUT).ok()
}

pub fn keyring_kek() -> Option<[u8; 32]> {
    let secret = with_timeout(|| {
        if in_flatpak() {
            portal_secret()
        } else {
            secret_service_secret()
        }
    })?;
    match secret {
        Ok(bytes) => Some(kek_from_secret(&bytes)),
        Err(e) => {
            eprintln!("Desktop keyring unavailable, falling back to {SECRET_FILE}: {e:#}");
            None
        }
    }
}

#[cfg(unix)]
fn portal_secret() -> Result<Vec<u8>> {
    use std::os::unix::net::UnixStream;
    use zbus::blocking::{Connection, Proxy};
    use zbus::zvariant::{Fd, ObjectPath, OwnedObjectPath, Value};

    let conn = Connection::session().context("connecting to the session bus")?;

    // The reply comes back as a signal on a request object, so it has to be
    // subscribed to before the call is made or the answer can arrive first.
    // Passing our own handle_token is what makes the path predictable.
    let mut token = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut token);
    let token = format!("bifrossh_{}", hex(&token));
    let unique = conn
        .unique_name()
        .ok_or_else(|| anyhow!("session bus gave us no unique name"))?
        .to_string();
    let request_path = format!(
        "/org/freedesktop/portal/desktop/request/{}/{}",
        unique.trim_start_matches(':').replace('.', "_"),
        token
    );

    let request = Proxy::new(
        &conn,
        "org.freedesktop.portal.Desktop",
        ObjectPath::try_from(request_path.as_str())?,
        "org.freedesktop.portal.Request",
    )?;
    let mut responses = request.receive_signal("Response")?;

    let (mut ours, theirs) = UnixStream::pair().context("creating the pipe for the secret")?;

    let secret = Proxy::new(
        &conn,
        "org.freedesktop.portal.Desktop",
        "/org/freedesktop/portal/desktop",
        "org.freedesktop.portal.Secret",
    )?;
    let mut options = std::collections::HashMap::new();
    options.insert("handle_token", Value::from(token.as_str()));
    let _: OwnedObjectPath = secret
        .call("RetrieveSecret", &(Fd::from(&theirs), options))
        .context("calling RetrieveSecret on the Secret portal")?;
    drop(theirs);

    let message = responses
        .next()
        .ok_or_else(|| anyhow!("the Secret portal closed without answering"))?;
    let (code, _): (u32, std::collections::HashMap<String, Value>) = message.body().deserialize()?;
    if code != 0 {
        return Err(anyhow!("the Secret portal refused the request (code {code})"));
    }

    let mut buf = Vec::new();
    ours.read_to_end(&mut buf).context("reading the secret")?;
    if buf.is_empty() {
        return Err(anyhow!("the Secret portal returned nothing"));
    }
    Ok(buf)
}

/// A Secret Service item of our own, created on first use.
///
/// The session is opened in "plain" mode, which sends the secret over the
/// session bus unencrypted. That is what every other client on a desktop
/// session does, and the alternative (a DH handshake) protects against an
/// attacker who can already read your session bus, which is to say one who has
/// already lost you the game.
#[cfg(unix)]
fn secret_service_secret() -> Result<Vec<u8>> {
    use std::collections::HashMap;
    use zbus::blocking::{Connection, Proxy};
    use zbus::zvariant::{ObjectPath, OwnedObjectPath, OwnedValue, Type, Value};

    #[derive(serde::Serialize, serde::Deserialize, Type)]
    struct SecretValue {
        session: OwnedObjectPath,
        parameters: Vec<u8>,
        value: Vec<u8>,
        content_type: String,
    }

    const SERVICE: &str = "org.freedesktop.secrets";
    let conn = Connection::session().context("connecting to the session bus")?;
    let service = Proxy::new(&conn, SERVICE, "/org/freedesktop/secrets", "org.freedesktop.Secret.Service")
        .context("no Secret Service on the session bus")?;

    let (_out, session): (OwnedValue, OwnedObjectPath) = service
        .call("OpenSession", &("plain", Value::from("")))
        .context("opening a Secret Service session")?;

    let attributes: HashMap<&str, &str> =
        [("application", APP_ID), ("xdg:schema", APP_ID)].into_iter().collect();

    let (unlocked, _locked): (Vec<OwnedObjectPath>, Vec<OwnedObjectPath>) =
        service.call("SearchItems", &(&attributes,))?;

    if let Some(path) = unlocked.first() {
        let item = Proxy::new(&conn, SERVICE, path.as_ref(), "org.freedesktop.Secret.Item")?;
        let secret: SecretValue = item.call("GetSecret", &(&session,))?;
        if !secret.value.is_empty() {
            return Ok(secret.value);
        }
    }

    // Nothing stored yet, so make one. A locked default collection would need
    // a prompt to write into, and rather than drive the prompt dance this
    // gives up and lets the caller fall back to the file.
    let mut fresh = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut fresh);

    let collection = Proxy::new(
        &conn,
        SERVICE,
        ObjectPath::try_from("/org/freedesktop/secrets/aliases/default")?,
        "org.freedesktop.Secret.Collection",
    )?;
    let mut properties: HashMap<&str, Value> = HashMap::new();
    properties.insert("org.freedesktop.Secret.Item.Label", Value::from("BifroSSH master key"));
    properties.insert("org.freedesktop.Secret.Item.Attributes", Value::from(attributes.clone()));

    let payload = SecretValue {
        session: session.clone(),
        parameters: Vec::new(),
        value: fresh.to_vec(),
        content_type: "application/octet-stream".to_string(),
    };
    let (item, prompt): (OwnedObjectPath, OwnedObjectPath) = collection
        .call("CreateItem", &(&properties, &payload, true))
        .context("storing the key in the Secret Service")?;
    if item.as_str() == "/" {
        return Err(anyhow!(
            "the keyring wants to prompt before storing (prompt {prompt}), which is not handled here"
        ));
    }
    Ok(fresh.to_vec())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ── Resolution ──────────────────────────────────────────────────────────────

/// The master key plus how it was found, so the caller can report it.
pub struct Unlocked {
    pub key: [u8; 32],
    pub source: KeySource,
    /// True when a passphrase is set and neither the keyring nor .secret could
    /// produce the key, meaning the user has to be asked.
    pub needs_passphrase: bool,
}

pub fn secret_file_path(dir: &Path) -> PathBuf {
    dir.join(SECRET_FILE)
}

fn read_secret_file(dir: &Path) -> Option<[u8; 32]> {
    let bytes = std::fs::read(secret_file_path(dir)).ok()?;
    bytes.as_slice().try_into().ok()
}

/// Works out the master key without asking the user anything.
///
/// Order matters. The keyring is tried first because that is the mechanism
/// worth using, but .secret is authoritative when both exist and disagree:
/// it is what the existing ciphertext was written with, and a keyring wrapper
/// that has drifted (a restored backup, a reset login keyring) must not be
/// allowed to hand back a key that decrypts nothing.
pub fn unlock(dir: &Path) -> Result<Unlocked> {
    let store = load_keystore(dir)?;
    let file_key = read_secret_file(dir);

    if let (Some(blob), Some(kek)) = (store.keyring.as_deref(), keyring_kek()) {
        match unwrap_key(blob, &kek) {
            Ok(key) => {
                if file_key.is_none_or(|f| f == key) {
                    return Ok(Unlocked { key, source: KeySource::Keyring, needs_passphrase: false });
                }
                eprintln!(
                    "The keyring holds a different key than {SECRET_FILE}; using the file, \
                     which is what the stored data was encrypted with."
                );
            }
            Err(e) => eprintln!("Could not unwrap the master key from the keyring: {e:#}"),
        }
    }

    if let Some(key) = file_key {
        return Ok(Unlocked { key, source: KeySource::File, needs_passphrase: false });
    }

    if store.passphrase.is_some() {
        return Ok(Unlocked {
            key: [0u8; 32],
            source: KeySource::Passphrase,
            needs_passphrase: true,
        });
    }

    Err(anyhow!(
        "No master key: neither the keyring nor {SECRET_FILE} has one and no passphrase is set"
    ))
}

/// [`unlock`], falling back to generating a key only when there is genuinely
/// nothing to lose.
///
/// The distinction matters more than it looks. Generating a fresh master key
/// whenever the old one cannot be found would turn any temporary problem, a
/// keyring that has not started yet, a home directory restored without its
/// dotfiles, into permanent loss of every stored credential: the new key
/// silently replaces the old one and data.json can never be read again. So an
/// existing data file with no reachable key is an error, and refusing to start
/// is the correct outcome, because it is the only one that is recoverable.
pub fn unlock_or_init(dir: &Path) -> Result<Unlocked> {
    match unlock(dir) {
        Ok(unlocked) => Ok(unlocked),
        Err(e) => {
            if dir.join(crate::store::DATA_FILE).exists() {
                return Err(e).context(
                    "There is saved data here but no key that can open it. Refusing to start \
                     rather than replace the key, which would make the data unreadable for good",
                );
            }
            Ok(Unlocked {
                key: crate::store::create_secret_file(dir)?,
                source: KeySource::File,
                needs_passphrase: false,
            })
        }
    }
}

/// Adds or refreshes the keyring wrapper for `master`. Best effort: a machine
/// with no keyring keeps working from the file.
pub fn store_keyring_wrapper(dir: &Path, master: &[u8; 32]) -> Result<bool> {
    let Some(kek) = keyring_kek() else { return Ok(false) };
    let mut store = load_keystore(dir)?;
    store.version = 1;
    store.keyring = Some(wrap(master, &kek)?);
    save_keystore(dir, &store)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(byte: u8) -> [u8; 32] {
        [byte; 32]
    }

    #[test]
    fn a_wrapped_key_comes_back_unchanged() {
        let (master, kek) = (key(7), key(9));
        assert_eq!(unwrap_key(&wrap(&master, &kek).unwrap(), &kek).unwrap(), master);
    }

    #[test]
    fn the_wrong_wrapping_key_does_not_unwrap() {
        let blob = wrap(&key(7), &key(9)).unwrap();
        assert!(unwrap_key(&blob, &key(10)).is_err());
    }

    #[test]
    fn wrapping_the_same_key_twice_gives_different_ciphertext() {
        // AES-GCM with a repeated nonce leaks the plaintext, so the nonce must
        // be fresh per wrap rather than derived from the key.
        let (master, kek) = (key(7), key(9));
        assert_ne!(wrap(&master, &kek).unwrap(), wrap(&master, &kek).unwrap());
    }

    #[test]
    fn a_passphrase_wrapper_round_trips() {
        let master = key(3);
        let w = new_passphrase_wrapper("correct horse battery staple", &master).unwrap();
        let kek = derive_passphrase_kek("correct horse battery staple", &w).unwrap();
        assert_eq!(unwrap_key(&w.blob, &kek).unwrap(), master);
    }

    #[test]
    fn the_wrong_passphrase_is_rejected() {
        let w = new_passphrase_wrapper("right", &key(3)).unwrap();
        let kek = derive_passphrase_kek("wrong", &w).unwrap();
        assert!(unwrap_key(&w.blob, &kek).is_err());
    }

    #[test]
    fn each_passphrase_wrapper_gets_its_own_salt() {
        let a = new_passphrase_wrapper("same", &key(3)).unwrap();
        let b = new_passphrase_wrapper("same", &key(3)).unwrap();
        assert_ne!(a.salt, b.salt);
    }

    #[test]
    fn stored_argon2_parameters_are_the_ones_used() {
        // Deriving with parameters other than the stored ones must not
        // accidentally succeed, or raising the cost later would lock users out
        // silently rather than loudly.
        let master = key(3);
        let w = new_passphrase_wrapper("pass", &master).unwrap();
        let mut altered = w.clone();
        altered.t_cost = w.t_cost + 1;
        let kek = derive_passphrase_kek("pass", &altered).unwrap();
        assert!(unwrap_key(&w.blob, &kek).is_err());
    }

    fn temp_dir() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static N: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "bifrossh-ks-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_first_run_with_nothing_on_disk_generates_a_key() {
        let dir = temp_dir();
        let unlocked = unlock_or_init(&dir).unwrap();
        assert_eq!(unlocked.source, KeySource::File);
        assert!(secret_file_path(&dir).exists());
        // And it is stable from then on.
        assert_eq!(unlock_or_init(&dir).unwrap().key, unlocked.key);
    }

    #[test]
    fn saved_data_with_no_reachable_key_refuses_rather_than_rekeying() {
        let dir = temp_dir();
        std::fs::write(dir.join(crate::store::DATA_FILE), "{\"ciphertext\":\"x\",\"version\":1}").unwrap();

        // Generating a fresh key here would orphan the file for good, so this
        // has to fail and it must not leave a new key behind.
        assert!(unlock_or_init(&dir).is_err());
        assert!(!secret_file_path(&dir).exists());
    }

    #[test]
    fn the_secret_file_wins_when_it_disagrees_with_the_keyring() {
        // The file is what the stored ciphertext was written with. A keyring
        // wrapper that has drifted, from a restored backup or a reset login
        // keyring, must not be preferred over it.
        let dir = temp_dir();
        let file_key = key(1);
        crate::store::write_private(&secret_file_path(&dir), &file_key).unwrap();
        let stale = KeyStore {
            version: 1,
            keyring: Some(wrap(&key(2), &key(3)).unwrap()),
            passphrase: None,
        };
        save_keystore(&dir, &stale).unwrap();

        let unlocked = unlock(&dir).unwrap();
        assert_eq!(unlocked.key, file_key);
        assert_eq!(unlocked.source, KeySource::File);
    }

    #[test]
    fn the_key_encryption_key_depends_on_the_keyring_secret() {
        assert_ne!(kek_from_secret(b"one"), kek_from_secret(b"two"));
        assert_eq!(kek_from_secret(b"one"), kek_from_secret(b"one"));
    }
}
