//! Getting the wrapping key out of the desktop keyring.
//!
//! Two backends behind one answer: the Secret portal inside Flatpak, the
//! Secret Service over D-Bus outside it. Which one runs is decided here, and
//! neither is visible to the rest of the app.
//!
//! Split out of `keystore` because it is platform plumbing rather than policy.
//! `keystore` decides what to do when the keyring is missing or locked; this
//! only reports which of those it is, and hands back a key when there is one.
//!
//! Nothing here protects a secret from another process running as the same
//! user, because on Linux nothing can: the Secret Service has no per
//! application access control for host processes. What it buys is that the key
//! is not in the file tree, and that inside Flatpak the portal scopes the
//! secret to this application id so other sandboxed apps get a different one.

use std::io::Read;
use std::path::Path;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use rand::RngCore;
use sha2::{Digest, Sha256};

/// The application id, which is what the Secret portal scopes its secret to
/// and what names the Secret Service item.
const APP_ID: &str = "io.github.aalmansadath.bifrossh";

/// A keyring that is present but locked will sit waiting for a prompter that,
/// under a bare window manager, may not exist. Startup must not hang on that.
const KEYRING_TIMEOUT: Duration = Duration::from_secs(5);

/// The keyring hands back an opaque blob of whatever length it likes (the
/// portal returns 64 bytes here), so it is hashed down to a key rather than
/// being used raw.
fn kek_from_secret(secret: &[u8]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(b"bifrossh-master-key-wrap-v1");
    hasher.update(secret);
    hasher.finalize().into()
}



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
        Err(e) => KeyringStatus::Unavailable(format!("{e:#}")),
    }
}

pub(crate) enum Outcome {
    Secret(Vec<u8>),
    Locked,
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

#[cfg(test)]
mod tests {
    use super::*;

    /// Different secrets must not wrap to the same key, and the same secret
    /// must keep opening what it wrapped before.
    #[test]
    fn the_key_encryption_key_depends_on_the_keyring_secret() {
        assert_ne!(kek_from_secret(b"one"), kek_from_secret(b"two"));
        assert_eq!(kek_from_secret(b"one"), kek_from_secret(b"one"));
    }
}
