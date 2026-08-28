//! The Linux backend: the Secret portal inside Flatpak, the Secret Service
//! outside it.
//!
//! Which one runs is decided here by whether we are sandboxed, because the two
//! answer different questions. Inside Flatpak the portal hands out a secret
//! scoped to this application id, so other sandboxed apps cannot ask for ours.
//! On the host the portal has no application id to scope by and returns the
//! same secret to every unsandboxed caller, so the Secret Service is used
//! directly there instead, with an item of our own.

use std::io::Read;
use std::path::Path;

use anyhow::{anyhow, Context, Result};
use rand::RngCore;

use super::Outcome;

/// The application id, which is what the Secret portal scopes its secret to
/// and what names the Secret Service item.
const APP_ID: &str = "io.github.aalmansadath.bifrossh";

fn in_flatpak() -> bool {
    Path::new("/.flatpak-info").exists()
}

pub(super) fn secret() -> Result<Outcome> {
    if in_flatpak() {
        // The portal gives no way to tell a missing secret from a locked
        // keyring, so anything other than a secret is reported as simply
        // unavailable.
        portal_secret().map(Outcome::Secret)
    } else {
        secret_service_secret()
    }
}


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
