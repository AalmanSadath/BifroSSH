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
    /// Whether to drop the keyring wrapper so the passphrase is always
    /// demanded. Off by default: with it off the passphrase is a way back in
    /// when the keyring is gone, and there is no way to be locked out. On, it
    /// is the only way in, which is the only setting that keeps anything from
    /// a process already running as this user.
    #[serde(default)]
    pub always_ask: bool,
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
    /// How the typed text is treated before it is hashed. Stored rather than
    /// assumed for the same reason the Argon2 parameters are: changing the
    /// rule later must not make existing keystores unopenable.
    #[serde(default)]
    pub form: PassphraseForm,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PassphraseForm {
    /// Exactly the bytes the user typed. Anything they chose themselves is
    /// treated this way: stripping punctuation from "My dog's name is Rex!"
    /// would both surprise them and throw away entropy they meant to have.
    #[default]
    Verbatim,
    /// A generated word phrase, compared with its separators normalised.
    ///
    /// This one is typed back from paper, possibly years later, so the ways it
    /// gets mangled are predictable: a trailing space from a paste, a newline
    /// where the display wrapped, hyphens instead of spaces, a capitalised
    /// first word. All of those are the same phrase and must open the vault.
    Words,
}

/// Lowercase, every run of non-alphanumerics becomes one space, ends trimmed.
fn canonical_words(input: &str) -> String {
    input
        .split(|c: char| !c.is_alphanumeric())
        .filter(|part| !part.is_empty())
        .map(|part| part.to_lowercase())
        .collect::<Vec<_>>()
        .join(" ")
}

fn prepare(passphrase: &str, form: PassphraseForm) -> String {
    match form {
        PassphraseForm::Verbatim => passphrase.to_string(),
        PassphraseForm::Words => canonical_words(passphrase),
    }
}

/// Default length for a generated phrase. Eight words is 88 bits, far past
/// what Argon2id needs to make guessing hopeless, and short enough that people
/// actually write it down.
pub const GENERATED_WORDS: usize = 8;

/// A fresh word phrase, drawn without modulo bias.
pub fn generate_passphrase() -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..GENERATED_WORDS)
        .map(|_| crate::wordlist::WORDS[rng.gen_range(0..crate::wordlist::WORDS.len())])
        .collect::<Vec<_>>()
        .join(" ")
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
    let prepared = prepare(passphrase, w.form);
    let mut kek = [0u8; 32];
    argon
        .hash_password_into(prepared.as_bytes(), &salt, &mut kek)
        .map_err(|e| anyhow!("Could not derive key from passphrase: {e}"))?;
    Ok(kek)
}

/// OWASP's second recommended Argon2id profile: 19 MiB, 2 passes. Chosen over
/// the heavier ones because this runs on the UI thread at unlock.
pub fn new_passphrase_wrapper(
    passphrase: &str,
    master: &[u8; 32],
    form: PassphraseForm,
) -> Result<PassphraseWrapper> {
    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let mut wrapper = PassphraseWrapper {
        salt: BASE64.encode(salt),
        m_cost: 19 * 1024,
        t_cost: 2,
        p_cost: 1,
        blob: String::new(),
        form,
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

/// Why the keyring did or did not produce a key, which is not the same
/// question as whether it produced one.
///
/// A locked keyring and a keyring that has lost our key look identical from
/// the outside and want opposite handling. Locked is temporary: the secret is
/// still in there, the wrapper written against it is still good, and the cure
/// is for the user to unlock it. Lost is permanent: the wrapper will never
/// open again and has to be rewritten. Treating locked as lost would rewrite a
/// perfectly good wrapper against whatever the keyring hands back later, and
/// telling the user their key is gone when it is merely asleep sends them
/// looking for a problem they do not have.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum KeyringStatus {
    Ready(Box<[u8; 32]>),
    /// Our item exists but the collection holding it will not open.
    Locked,
    /// The service answered and has nothing of ours, so one can be made.
    Missing,
    /// No keyring at all, or it failed in a way worth neither of the above.
    Unavailable(String),
}

pub fn keyring_status() -> KeyringStatus {
    let Some(result) = with_timeout(|| {
        if in_flatpak() {
            // The portal gives no way to tell these apart, so anything other
            // than a secret is reported as simply unavailable.
            portal_secret().map(Outcome::Secret)
        } else {
            secret_service_secret()
        }
    }) else {
        return KeyringStatus::Unavailable("the keyring did not answer in time".to_string());
    };

    match result {
        Ok(Outcome::Secret(bytes)) => KeyringStatus::Ready(Box::new(kek_from_secret(&bytes))),
        Ok(Outcome::Locked) => KeyringStatus::Locked,
        Ok(Outcome::Missing) => KeyringStatus::Missing,
        Err(e) => KeyringStatus::Unavailable(format!("{e:#}")),
    }
}

pub(crate) enum Outcome {
    Secret(Vec<u8>),
    Locked,
    Missing,
}

pub fn keyring_kek() -> Option<[u8; 32]> {
    match keyring_status() {
        KeyringStatus::Ready(kek) => Some(*kek),
        KeyringStatus::Locked => {
            eprintln!("The desktop keyring is locked, so it cannot open BifroSSH right now.");
            None
        }
        KeyringStatus::Missing => None,
        KeyringStatus::Unavailable(why) => {
            eprintln!("Desktop keyring unavailable: {why}");
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
fn secret_service_secret() -> Result<Outcome> {
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

    let (unlocked, locked): (Vec<OwnedObjectPath>, Vec<OwnedObjectPath>) =
        service.call("SearchItems", &(&attributes,))?;

    if let Some(path) = unlocked.first() {
        let item = Proxy::new(&conn, SERVICE, path.as_ref(), "org.freedesktop.Secret.Item")?;
        let secret: SecretValue = item.call("GetSecret", &(&session,))?;
        if !secret.value.is_empty() {
            return Ok(Outcome::Secret(secret.value));
        }
    }

    // Our key is in there; the collection holding it just will not open, which
    // happens whenever the login keyring is not unlocked at login, as with
    // autologin or a keyring password that differs from the login one.
    //
    // Reported rather than treated as missing, and emphatically not replaced.
    // Creating an item with these attributes would overwrite the one that is
    // sitting there perfectly intact, and every wrapper written against it
    // would stop opening. A keyring the user only has to unlock must never
    // become a key they have permanently lost.
    if !locked.is_empty() || !unlocked.is_empty() {
        return Ok(Outcome::Locked);
    }

    // Genuinely nothing stored yet, so make one. A locked default collection
    // would need a prompt to write into, and rather than drive the prompt
    // dance this gives up and lets the caller fall back.
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
    Ok(Outcome::Secret(fresh.to_vec()))
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

/// Where the key effectively lives right now, read off the disk rather than
/// remembered from startup.
///
/// Reported from the current state because the arrangement can change while
/// the app is running, and a status captured at launch would keep describing
/// the old one.
///
/// The weakest location wins. A profile can hold a keyring wrapper and
/// .secret at the same time, and calling that "in your keyring" would be a
/// flattering description of a key that is still sitting in the file tree
/// where any copy of the home directory picks it up.
pub fn current_source(dir: &Path, keyring_available: bool) -> KeySource {
    if secret_file_path(dir).exists() {
        return KeySource::File;
    }
    let store = load_keystore(dir).unwrap_or_default();
    if store.keyring.is_some() && keyring_available {
        return KeySource::Keyring;
    }
    if store.passphrase.is_some() {
        return KeySource::Passphrase;
    }
    KeySource::File
}

/// Recognises a phrase this app generated, which is the only kind whose
/// spacing is normalised.
///
/// Detected rather than passed in, so that pasting a generated phrase into the
/// Settings box gets the forgiving treatment too, and so a user who happens to
/// type eight of these words gets it as well, which costs them nothing.
pub fn detect_form(passphrase: &str) -> PassphraseForm {
    let words: Vec<&str> = passphrase.split_whitespace().collect();
    let all_from_list = words
        .iter()
        .all(|w| crate::wordlist::WORDS.contains(&w.to_lowercase().as_str()));
    if words.len() >= GENERATED_WORDS && all_from_list {
        PassphraseForm::Words
    } else {
        PassphraseForm::Verbatim
    }
}

/// Whether this profile has never been set up: no key anywhere, and no data
/// that would have needed one.
pub fn is_first_run(dir: &Path) -> bool {
    !secret_file_path(dir).exists()
        && !dir.join(crate::store::DATA_FILE).exists()
        && load_keystore(dir).map(|s| s.keyring.is_none() && s.passphrase.is_none()).unwrap_or(false)
}

/// What the user picked on the first run screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum InitMode {
    /// Key in .secret beside the data. No passphrase, nothing to forget, and
    /// no protection beyond the file being unreadable by other accounts.
    SecretFile,
    /// Passphrase only, demanded at every launch.
    PassphraseOnly,
    /// Keyring opens it silently, passphrase is the way back if it is lost.
    KeyringAndPassphrase,
}

/// Creates the master key the way the user asked for on first run.
///
/// The key is generated here and never leaves; what differs is only which
/// wrappers get written. Nothing is returned until the arrangement has been
/// read back from disk and shown to produce the same key, because a keystore
/// that cannot be reopened is not discovered until the next launch, by which
/// point whatever was saved in between is unreachable.
pub fn initialize(dir: &Path, mode: InitMode, passphrase: &str) -> Result<[u8; 32]> {
    let mut master = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut master);

    let needs_passphrase = mode != InitMode::SecretFile;
    if needs_passphrase && passphrase.is_empty() {
        return Err(anyhow!("A passphrase is required for this option"));
    }

    let form = detect_form(passphrase);

    let mut store = KeyStore { version: 1, ..Default::default() };
    if mode == InitMode::KeyringAndPassphrase {
        let kek = keyring_kek()
            .ok_or_else(|| anyhow!("No desktop keyring answered, so it cannot hold the key"))?;
        store.keyring = Some(wrap(&master, &kek)?);
    }
    if needs_passphrase {
        store.passphrase = Some(new_passphrase_wrapper(passphrase, &master, form)?);
        store.always_ask = mode == InitMode::PassphraseOnly;
    }
    save_keystore(dir, &store)?;

    if mode == InitMode::SecretFile {
        crate::store::write_private(&secret_file_path(dir), &master)?;
    }

    // Read it back the way a later launch would, and check every route that
    // was just written actually opens.
    if needs_passphrase && unlock_with_passphrase(dir, passphrase)? != master {
        return Err(anyhow!("The passphrase did not open the keystore it just created"));
    }
    let reopened = unlock(dir).context("reopening the keystore that was just written")?;
    if !reopened.needs_passphrase && reopened.key != master {
        return Err(anyhow!("The keystore that was just written does not open to the same key"));
    }
    Ok(master)
}

/// Adds a passphrase and takes the key off the disk.
///
/// .secret always goes: the passphrase is what replaces it, and leaving it
/// would mean the key is still in the file tree next to the data, which is the
/// thing being avoided.
///
/// What happens to the keyring depends on `always_ask`. Left off, the keyring
/// still opens the vault without a prompt and the passphrase is the way back
/// in when the keyring is not there, so nothing can lock the owner out. Turned
/// on, the keyring wrapper is dropped and the passphrase is demanded every
/// time, which is the only arrangement that keeps anything from something
/// already running as this user, and the only one where forgetting it loses
/// the data for good.
pub fn set_passphrase(
    dir: &Path,
    master: &[u8; 32],
    passphrase: &str,
    always_ask: bool,
    form: PassphraseForm,
) -> Result<()> {
    if passphrase.is_empty() {
        return Err(anyhow!("The passphrase cannot be empty"));
    }
    let wrapper = new_passphrase_wrapper(passphrase, master, form)?;

    // Prove it opens before anything that currently works is taken away.
    let check = derive_passphrase_kek(passphrase, &wrapper)?;
    if unwrap_key(&wrapper.blob, &check)? != *master {
        return Err(anyhow!("The new passphrase did not verify; nothing was changed"));
    }

    let mut store = load_keystore(dir)?;
    store.version = 1;
    store.passphrase = Some(wrapper);
    store.always_ask = always_ask;
    if always_ask {
        store.keyring = None;
    }
    save_keystore(dir, &store)?;

    // Establish the keyring route if there is not one yet, so that removing
    // .secret below does not leave the passphrase as the only way in on a
    // machine that has a keyring. An existing wrapper is left exactly as it
    // is: rewriting one that already opens gains nothing and can only fail.
    if !always_ask && store.keyring.is_none() {
        let _ = store_keyring_wrapper(dir, master);
    }
    let secret = secret_file_path(dir);
    if secret.exists() {
        std::fs::remove_file(&secret)
            .with_context(|| format!("removing {}", secret.display()))?;
    }
    Ok(())
}

/// Switches between the keyring being allowed to open the vault and the
/// passphrase being demanded every time. Only meaningful once a passphrase
/// exists, since otherwise there would be nothing left to unlock with.
pub fn set_always_ask(dir: &Path, master: &[u8; 32], always_ask: bool) -> Result<()> {
    let mut store = load_keystore(dir)?;
    if store.passphrase.is_none() {
        return Err(anyhow!("Set a passphrase before asking for it to be required"));
    }
    store.always_ask = always_ask;
    store.keyring = None;
    save_keystore(dir, &store)?;
    if !always_ask {
        let _ = store_keyring_wrapper(dir, master);
    }
    Ok(())
}

/// Puts things back the way they were: the key returns to the keyring and to
/// .secret, and no passphrase is asked for again.
pub fn clear_passphrase(dir: &Path, master: &[u8; 32]) -> Result<()> {
    // Written before the wrapper is dropped, so an interruption leaves a
    // keystore that can still be opened rather than one that cannot.
    crate::store::write_private(&secret_file_path(dir), master)?;
    let mut store = load_keystore(dir)?;
    store.passphrase = None;
    store.always_ask = false;
    save_keystore(dir, &store)?;
    let _ = store_keyring_wrapper(dir, master);
    Ok(())
}

/// Unwraps the master key with a passphrase the user typed.
pub fn unlock_with_passphrase(dir: &Path, passphrase: &str) -> Result<[u8; 32]> {
    let store = load_keystore(dir)?;
    let wrapper = store
        .passphrase
        .clone()
        .ok_or_else(|| anyhow!("No passphrase is set on this keystore"))?;
    let kek = derive_passphrase_kek(passphrase, &wrapper)?;
    let master = unwrap_key(&wrapper.blob, &kek).map_err(|_| anyhow!("Wrong passphrase"))?;

    // Being asked for the passphrase when the keyring was supposed to handle
    // it means something is wrong with the keyring wrapper, and this is the
    // only moment the master key is in hand to fix it. Nothing else repairs
    // it: the launch path refreshes the wrapper only once the keyring already
    // works, so a dead one would stay dead and prompt on every launch.
    let status = if store.always_ask { KeyringStatus::Missing } else { keyring_status() };
    let wrapper_opens = match (&store.keyring, &status) {
        (Some(blob), KeyringStatus::Ready(kek)) => unwrap_key(blob, kek).is_ok(),
        _ => false,
    };
    if should_repair_keyring(&status, store.always_ask, wrapper_opens) {
        if let Ok(true) = store_keyring_wrapper(dir, &master) {
            eprintln!("Repaired the keyring copy of the master key.");
        }
    }
    Ok(master)
}

pub fn has_passphrase(dir: &Path) -> bool {
    load_keystore(dir).map(|s| s.passphrase.is_some()).unwrap_or(false)
}

pub fn always_asks(dir: &Path) -> bool {
    load_keystore(dir).map(|s| s.always_ask).unwrap_or(false)
}

/// Whether an unopenable keyring wrapper should be rewritten now.
///
/// The distinction this exists for: a locked keyring still holds the secret
/// the current wrapper was written against, so the wrapper is good and the fix
/// belongs to the user, who unlocks their keyring. Rewriting it here would
/// throw away something that works in favour of whatever a future unlock
/// happens to return.
fn should_repair_keyring(status: &KeyringStatus, always_ask: bool, wrapper_opens: bool) -> bool {
    if always_ask || wrapper_opens {
        return false;
    }
    match status {
        // Answered, but the wrapper did not open, so the secret behind it
        // changed and the wrapper is dead.
        KeyringStatus::Ready(_) => true,
        // Nothing of ours stored; one can be made.
        KeyringStatus::Missing => true,
        // Temporary. Leave the wrapper alone.
        KeyringStatus::Locked => false,
        // No keyring to write to anyway.
        KeyringStatus::Unavailable(_) => false,
    }
}

/// Adds or refreshes the keyring wrapper for `master`. Best effort: a machine
/// with no keyring keeps working from the file.
pub fn store_keyring_wrapper(dir: &Path, master: &[u8; 32]) -> Result<bool> {
    let mut store = load_keystore(dir)?;

    // This runs on every launch so that a keyring appearing later starts being
    // used on its own. When the user has asked to always be prompted, putting
    // a wrapper back would stop the passphrase ever being demanded again and
    // silently undo the setting, so leave it alone.
    if store.always_ask {
        return Ok(false);
    }

    let Some(kek) = keyring_kek() else { return Ok(false) };
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
        let w = new_passphrase_wrapper("correct horse battery staple", &master, PassphraseForm::Verbatim).unwrap();
        let kek = derive_passphrase_kek("correct horse battery staple", &w).unwrap();
        assert_eq!(unwrap_key(&w.blob, &kek).unwrap(), master);
    }

    #[test]
    fn the_wrong_passphrase_is_rejected() {
        let w = new_passphrase_wrapper("right", &key(3), PassphraseForm::Verbatim).unwrap();
        let kek = derive_passphrase_kek("wrong", &w).unwrap();
        assert!(unwrap_key(&w.blob, &kek).is_err());
    }

    #[test]
    fn each_passphrase_wrapper_gets_its_own_salt() {
        let a = new_passphrase_wrapper("same", &key(3), PassphraseForm::Verbatim).unwrap();
        let b = new_passphrase_wrapper("same", &key(3), PassphraseForm::Verbatim).unwrap();
        assert_ne!(a.salt, b.salt);
    }

    #[test]
    fn stored_argon2_parameters_are_the_ones_used() {
        // Deriving with parameters other than the stored ones must not
        // accidentally succeed, or raising the cost later would lock users out
        // silently rather than loudly.
        let master = key(3);
        let w = new_passphrase_wrapper("pass", &master, PassphraseForm::Verbatim).unwrap();
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
    fn an_empty_profile_is_a_first_run() {
        assert!(is_first_run(&temp_dir()));
    }

    #[test]
    fn saved_data_with_no_reachable_key_is_not_mistaken_for_a_first_run() {
        // Treating it as one would offer to make a new key, and the file that
        // is already there would never be readable again.
        let dir = temp_dir();
        std::fs::write(dir.join(crate::store::DATA_FILE), "{\"ciphertext\":\"x\",\"version\":1}").unwrap();
        assert!(!is_first_run(&dir));
        assert!(unlock(&dir).is_err());
        assert!(!secret_file_path(&dir).exists());
    }

    #[test]
    fn a_profile_that_has_a_key_is_not_a_first_run() {
        let dir = temp_dir();
        crate::store::write_private(&secret_file_path(&dir), &key(1)).unwrap();
        assert!(!is_first_run(&dir));
    }

    #[test]
    fn each_option_on_the_first_run_screen_produces_a_keystore_that_reopens() {
        for mode in [InitMode::SecretFile, InitMode::PassphraseOnly] {
            let dir = temp_dir();
            let master = initialize(&dir, mode, "eight word phrase goes right here now").unwrap();
            let reopened = unlock(&dir).unwrap();
            match mode {
                InitMode::SecretFile => {
                    assert!(secret_file_path(&dir).exists());
                    assert_eq!(reopened.key, master);
                }
                _ => {
                    assert!(!secret_file_path(&dir).exists(), "{mode:?} left the key on disk");
                    assert!(reopened.needs_passphrase);
                    assert_eq!(
                        unlock_with_passphrase(&dir, "eight word phrase goes right here now").unwrap(),
                        master
                    );
                }
            }
        }
    }

    #[test]
    fn the_passphrase_options_refuse_an_empty_passphrase() {
        for mode in [InitMode::PassphraseOnly, InitMode::KeyringAndPassphrase] {
            let dir = temp_dir();
            assert!(initialize(&dir, mode, "").is_err(), "{mode:?} accepted nothing");
            assert!(is_first_run(&dir), "{mode:?} left the profile half made");
        }
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
            always_ask: false,
        };
        save_keystore(&dir, &stale).unwrap();

        let unlocked = unlock(&dir).unwrap();
        assert_eq!(unlocked.key, file_key);
        assert_eq!(unlocked.source, KeySource::File);
    }

    #[test]
    fn always_ask_takes_away_every_other_way_in() {
        let dir = temp_dir();
        let master = key(5);
        crate::store::write_private(&secret_file_path(&dir), &master).unwrap();
        save_keystore(&dir, &KeyStore {
            version: 1,
            keyring: Some(wrap(&master, &key(6)).unwrap()),
            passphrase: None,
            always_ask: false,
        }).unwrap();

        set_passphrase(&dir, &master, "hunter2", true, PassphraseForm::Verbatim).unwrap();

        // Both are gone on purpose: a keyring wrapper would mean unlock never
        // asks, and .secret would mean the key is still in the file tree.
        assert!(!secret_file_path(&dir).exists(), ".secret still there");
        assert!(load_keystore(&dir).unwrap().keyring.is_none(), "keyring wrapper still there");
        assert_eq!(unlock_with_passphrase(&dir, "hunter2").unwrap(), master);
    }

    #[test]
    fn an_empty_passphrase_is_refused_before_anything_is_removed() {
        let dir = temp_dir();
        let master = key(5);
        crate::store::write_private(&secret_file_path(&dir), &master).unwrap();

        assert!(set_passphrase(&dir, &master, "", true, PassphraseForm::Verbatim).is_err());
        assert!(secret_file_path(&dir).exists(), ".secret was removed anyway");
    }

    #[test]
    fn a_keystore_with_only_a_passphrase_asks_for_one() {
        let dir = temp_dir();
        let master = key(5);
        crate::store::write_private(&secret_file_path(&dir), &master).unwrap();
        set_passphrase(&dir, &master, "hunter2", true, PassphraseForm::Verbatim).unwrap();

        let unlocked = unlock(&dir).unwrap();
        assert!(unlocked.needs_passphrase);
        assert_eq!(unlocked.source, KeySource::Passphrase);
    }

    #[test]
    fn refreshing_the_keyring_wrapper_cannot_undo_a_passphrase() {
        // store_keyring_wrapper runs on every launch. If it re-added a wrapper
        // the keyring would unlock first and the passphrase would never be
        // asked for again, silently turning the protection off.
        let dir = temp_dir();
        let master = key(5);
        crate::store::write_private(&secret_file_path(&dir), &master).unwrap();
        set_passphrase(&dir, &master, "hunter2", true, PassphraseForm::Verbatim).unwrap();

        assert!(!store_keyring_wrapper(&dir, &master).unwrap());
        assert!(load_keystore(&dir).unwrap().keyring.is_none());
    }

    #[test]
    fn a_passphrase_opens_data_that_was_saved_before_it_was_set() {
        // The whole chain unlock_vault runs: derive the key from the
        // passphrase, then read the file that was encrypted with the master
        // key that passphrase wraps.
        let dir = temp_dir();
        let master = { let k = key(9); crate::store::write_private(&secret_file_path(&dir), &k).unwrap(); k };

        let mut data = crate::models::AppData::default();
        data.codeprints.push(crate::models::Codeprint {
            id: "id".into(), name: "before".into(), command: "true".into(),
        });
        crate::store::save_app_data_in(&dir, &data, &master).unwrap();

        set_passphrase(&dir, &master, "hunter2", true, PassphraseForm::Verbatim).unwrap();

        let key = unlock_with_passphrase(&dir, "hunter2").unwrap();
        let loaded = crate::store::load_app_data_in(&dir, &key).unwrap();
        assert_eq!(loaded.codeprints[0].name, "before");
    }

    #[test]
    fn a_wrong_passphrase_yields_no_key_at_all() {
        let dir = temp_dir();
        let master = { let k = key(9); crate::store::write_private(&secret_file_path(&dir), &k).unwrap(); k };
        set_passphrase(&dir, &master, "right", true, PassphraseForm::Verbatim).unwrap();
        // Must be an error, not some other key: a key that is merely wrong
        // would decrypt nothing and could be published as if the vault were
        // open.
        assert!(unlock_with_passphrase(&dir, "wrong").is_err());
    }

    #[test]
    fn without_always_ask_the_keyring_still_opens_it_and_the_key_leaves_the_disk() {
        let dir = temp_dir();
        let master = key(5);
        crate::store::write_private(&secret_file_path(&dir), &master).unwrap();
        // Stand in for a keyring wrapper, since there may be no keyring here.
        save_keystore(&dir, &KeyStore {
            version: 1,
            keyring: Some(wrap(&master, &key(6)).unwrap()),
            passphrase: None,
            always_ask: false,
        }).unwrap();

        set_passphrase(&dir, &master, "hunter2", false, PassphraseForm::Verbatim).unwrap();

        let store = load_keystore(&dir).unwrap();
        assert!(store.keyring.is_some(), "the keyring route was removed anyway");
        assert!(store.passphrase.is_some());
        assert!(!store.always_ask);
        // The point of setting one: the key is no longer beside the data.
        assert!(!secret_file_path(&dir).exists(), ".secret survived");
    }

    #[test]
    fn without_always_ask_there_are_two_ways_in_so_nobody_is_locked_out() {
        let dir = temp_dir();
        let master = key(5);
        crate::store::write_private(&secret_file_path(&dir), &master).unwrap();
        let kek = key(6);
        save_keystore(&dir, &KeyStore {
            version: 1,
            keyring: Some(wrap(&master, &kek).unwrap()),
            passphrase: None,
            always_ask: false,
        }).unwrap();
        set_passphrase(&dir, &master, "hunter2", false, PassphraseForm::Verbatim).unwrap();

        let store = load_keystore(&dir).unwrap();
        // Forgetting the passphrase leaves the keyring, and losing the keyring
        // leaves the passphrase. Either one alone recovers the master key.
        assert_eq!(unwrap_key(store.keyring.as_deref().unwrap(), &kek).unwrap(), master);
        assert_eq!(unlock_with_passphrase(&dir, "hunter2").unwrap(), master);
    }

    #[test]
    fn turning_always_ask_on_later_drops_the_keyring_route() {
        let dir = temp_dir();
        let master = key(5);
        crate::store::write_private(&secret_file_path(&dir), &master).unwrap();
        save_keystore(&dir, &KeyStore {
            version: 1,
            keyring: Some(wrap(&master, &key(6)).unwrap()),
            passphrase: None,
            always_ask: false,
        }).unwrap();
        set_passphrase(&dir, &master, "hunter2", false, PassphraseForm::Verbatim).unwrap();

        set_always_ask(&dir, &master, true).unwrap();

        let store = load_keystore(&dir).unwrap();
        assert!(store.always_ask);
        assert!(store.keyring.is_none());
        assert!(unlock(&dir).unwrap().needs_passphrase);
    }

    #[test]
    fn always_ask_is_refused_when_there_is_no_passphrase_to_ask_for() {
        // Otherwise this would remove the keyring wrapper and leave nothing.
        let dir = temp_dir();
        let master = key(5);
        crate::store::write_private(&secret_file_path(&dir), &master).unwrap();
        assert!(set_always_ask(&dir, &master, true).is_err());
    }

    #[test]
    fn clearing_a_passphrase_puts_the_key_back_in_the_file() {
        let dir = temp_dir();
        let master = key(5);
        crate::store::write_private(&secret_file_path(&dir), &master).unwrap();
        set_passphrase(&dir, &master, "hunter2", true, PassphraseForm::Verbatim).unwrap();

        clear_passphrase(&dir, &master).unwrap();

        assert!(load_keystore(&dir).unwrap().passphrase.is_none());
        let unlocked = unlock(&dir).unwrap();
        assert!(!unlocked.needs_passphrase);
        assert_eq!(unlocked.key, master);
    }

    #[test]
    fn the_wordlist_keeps_the_properties_the_design_leans_on() {
        use std::collections::HashSet;
        let words = crate::wordlist::WORDS;

        // A power of two means every word carries a whole number of bits and
        // the draw below needs no rejection sampling to stay unbiased.
        assert_eq!(words.len(), 2048);
        assert_eq!(words.iter().collect::<HashSet<_>>().len(), words.len(), "duplicate word");

        for w in words {
            // A word with a space, hyphen or capital in it could not survive
            // the separator collapsing that makes a written down phrase
            // forgiving to type back.
            assert!(w.chars().all(|c| c.is_ascii_lowercase()), "{w} is not plain lowercase");
            assert!((3..=8).contains(&w.len()), "{w} is an awkward length");
        }

        // Unique four letter prefixes: a word stays recoverable when the tail
        // of it is illegible on paper, which is the failure this list is for.
        assert_eq!(
            words.iter().map(|w| &w[..4.min(w.len())]).collect::<HashSet<_>>().len(),
            words.len(),
            "two words share their first four letters"
        );
    }

    #[test]
    fn a_generated_phrase_is_eight_words_from_the_list() {
        let phrase = generate_passphrase();
        let words: Vec<&str> = phrase.split(' ').collect();
        assert_eq!(words.len(), GENERATED_WORDS);
        for w in &words {
            assert!(crate::wordlist::WORDS.contains(w), "{w} is not on the list");
        }
        assert_ne!(phrase, generate_passphrase());
        assert_eq!(detect_form(&phrase), PassphraseForm::Words);
    }

    #[test]
    fn a_generated_phrase_survives_being_written_down_and_typed_back() {
        // Every one of these is how the same phrase comes back from a person:
        // pasted with a trailing space, wrapped onto two lines, joined with
        // hyphens because that is what it looked like, first word capitalised
        // out of habit, an extra space between two words.
        let dir = temp_dir();
        let master = key(4);
        crate::store::write_private(&secret_file_path(&dir), &master).unwrap();
        let phrase = "acid acorn acre acts afar affix aged agent";
        set_passphrase(&dir, &master, phrase, true, PassphraseForm::Words).unwrap();

        for typed in [
            "acid acorn acre acts afar affix aged agent",
            "acid acorn acre acts afar affix aged agent ",
            "  acid acorn acre acts afar affix aged agent",
            "acid-acorn-acre-acts-afar-affix-aged-agent",
            "acid acorn acre acts\nafar affix aged agent",
            "Acid Acorn Acre Acts Afar Affix Aged Agent",
            "acid  acorn   acre acts afar affix aged agent",
        ] {
            assert_eq!(
                unlock_with_passphrase(&dir, typed).unwrap(),
                master,
                "did not open with {typed:?}",
            );
        }
    }

    #[test]
    fn a_different_phrase_is_still_refused_after_normalising() {
        let dir = temp_dir();
        let master = key(4);
        crate::store::write_private(&secret_file_path(&dir), &master).unwrap();
        set_passphrase(&dir, &master, "acid acorn acre acts afar affix aged agent", true,
                       PassphraseForm::Words).unwrap();
        // One word out is still the wrong phrase, normalising or not.
        assert!(unlock_with_passphrase(&dir, "acid acorn acre acts afar affix aged agile").is_err());
    }

    #[test]
    fn a_passphrase_the_user_chose_is_taken_exactly_as_typed() {
        // Normalising this one would throw away entropy they meant to have and
        // silently accept variations they did not intend.
        let dir = temp_dir();
        let master = key(4);
        crate::store::write_private(&secret_file_path(&dir), &master).unwrap();
        let chosen = "My dog's name is Rex!";
        set_passphrase(&dir, &master, chosen, true, PassphraseForm::Verbatim).unwrap();

        assert_eq!(unlock_with_passphrase(&dir, chosen).unwrap(), master);
        for near_miss in ["my dog's name is rex!", "My dogs name is Rex", "My dog's name is Rex! "] {
            assert!(unlock_with_passphrase(&dir, near_miss).is_err(), "{near_miss:?} was accepted");
        }
    }

    #[test]
    fn something_typed_by_hand_is_not_mistaken_for_a_generated_phrase() {
        assert_eq!(detect_form("My dog's name is Rex!"), PassphraseForm::Verbatim);
        assert_eq!(detect_form("acid acorn acre"), PassphraseForm::Verbatim);
        assert_eq!(detect_form(""), PassphraseForm::Verbatim);
    }

    #[test]
    fn the_reported_location_names_the_weakest_one() {
        let dir = temp_dir();
        let master = key(1);

        // A keyring wrapper alongside .secret is not "in your keyring": the
        // file alone opens everything and travels with any copy of the home
        // directory, so calling it protected would be a lie.
        crate::store::write_private(&secret_file_path(&dir), &master).unwrap();
        save_keystore(&dir, &KeyStore {
            version: 1,
            keyring: Some(wrap(&master, &key(2)).unwrap()),
            passphrase: None,
            always_ask: false,
        }).unwrap();
        assert_eq!(current_source(&dir, true), KeySource::File);

        // Once the file is gone the keyring is the honest answer.
        std::fs::remove_file(secret_file_path(&dir)).unwrap();
        assert_eq!(current_source(&dir, true), KeySource::Keyring);

        // And it stops being the answer the moment no keyring replies.
        assert_eq!(current_source(&dir, false), KeySource::File);
    }

    #[test]
    fn the_reported_location_follows_a_change_rather_than_the_startup_state() {
        // Removing a passphrase and setting one again used to keep reporting
        // whatever was true when the process started.
        let dir = temp_dir();
        let master = key(1);
        crate::store::write_private(&secret_file_path(&dir), &master).unwrap();
        assert_eq!(current_source(&dir, false), KeySource::File);

        set_passphrase(&dir, &master, "hunter2", true, PassphraseForm::Verbatim).unwrap();
        assert_eq!(current_source(&dir, false), KeySource::Passphrase);

        clear_passphrase(&dir, &master).unwrap();
        assert_eq!(current_source(&dir, false), KeySource::File);
    }

    #[test]
    fn a_locked_keyring_is_never_treated_as_a_lost_one() {
        // The whole point of telling them apart. A locked keyring still holds
        // the secret the wrapper was written against, so the wrapper is fine
        // and rewriting it would discard something that works.
        let ready = KeyringStatus::Ready(Box::new(key(3)));

        assert!(!should_repair_keyring(&KeyringStatus::Locked, false, false),
                "rewrote a good wrapper because the keyring was merely locked");
        assert!(!should_repair_keyring(&KeyringStatus::Unavailable("no bus".into()), false, false),
                "tried to write to a keyring that is not there");

        // Answered, and the wrapper still did not open: the secret behind it
        // was replaced, so the wrapper really is dead.
        assert!(should_repair_keyring(&ready, false, false));
        // Nothing of ours stored yet, so there is one to make.
        assert!(should_repair_keyring(&KeyringStatus::Missing, false, false));

        // Never touch a wrapper that works, and never hand the keyring a way
        // in when the user asked to always be prompted.
        assert!(!should_repair_keyring(&ready, false, true));
        assert!(!should_repair_keyring(&ready, true, false));
        assert!(!should_repair_keyring(&KeyringStatus::Missing, true, false));
    }

    #[test]
    fn a_dead_keyring_wrapper_is_repaired_by_unlocking_with_the_passphrase() {
        // The keyring secret can be replaced out from under a wrapper, leaving
        // it unopenable. Before, the launch path only refreshed the wrapper
        // once the keyring already worked, so a dead one stayed dead and the
        // passphrase was demanded at every launch for good.
        let dir = temp_dir();
        let master = key(1);
        crate::store::write_private(&secret_file_path(&dir), &master).unwrap();
        set_passphrase(&dir, &master, "hunter2", false, PassphraseForm::Verbatim).unwrap();

        // Stand in for a wrapper written against a keyring secret that is gone.
        let mut store = load_keystore(&dir).unwrap();
        store.keyring = Some(wrap(&master, &key(99)).unwrap());
        save_keystore(&dir, &store).unwrap();
        assert!(unlock(&dir).unwrap().needs_passphrase, "the dead wrapper should not open it");

        assert_eq!(unlock_with_passphrase(&dir, "hunter2").unwrap(), master);

        // Only meaningful where a keyring actually answers, which is not
        // guaranteed on a build machine.
        if keyring_kek().is_some() {
            assert!(!unlock(&dir).unwrap().needs_passphrase, "still asking after the repair");
            assert_eq!(unlock(&dir).unwrap().source, KeySource::Keyring);
        }
    }

    #[test]
    fn always_ask_is_not_undone_by_a_passphrase_unlock() {
        let dir = temp_dir();
        let master = key(1);
        crate::store::write_private(&secret_file_path(&dir), &master).unwrap();
        set_passphrase(&dir, &master, "hunter2", true, PassphraseForm::Verbatim).unwrap();

        unlock_with_passphrase(&dir, "hunter2").unwrap();

        // The repair above must not quietly hand the keyring a way in again.
        assert!(load_keystore(&dir).unwrap().keyring.is_none());
        assert!(unlock(&dir).unwrap().needs_passphrase);
    }

    #[test]
    fn the_key_encryption_key_depends_on_the_keyring_secret() {
        assert_ne!(kek_from_secret(b"one"), kek_from_secret(b"two"));
        assert_eq!(kek_from_secret(b"one"), kek_from_secret(b"one"));
    }
}

