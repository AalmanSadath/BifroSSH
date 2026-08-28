//! Getting the wrapping key out of whatever the platform offers as a keyring.
//!
//! One answer, three backends behind it: on Linux the Secret portal inside
//! Flatpak and the Secret Service outside it, on Windows DPAPI. Which one runs
//! is decided by `cfg` here, and none of them is visible to the rest of the
//! app.
//!
//! Split out of `keystore` because it is platform plumbing rather than policy.
//! `keystore` decides what to do when the keyring is missing or locked; this
//! only reports which of those it is, and hands back a key when there is one.
//!
//! Nothing here protects a secret from another process running as the same
//! user, on either platform, because neither platform offers that. The Secret
//! Service has no per application access control for host processes, and DPAPI
//! is scoped to the Windows account. What it buys is that the key is not
//! sitting in the file tree in the clear, and that inside Flatpak the portal
//! scopes the secret to this application id so other sandboxed apps get a
//! different one.

use std::time::Duration;

use sha2::{Digest, Sha256};

#[cfg(unix)]
mod unix;
#[cfg(unix)]
use unix as backend;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
use windows as backend;

#[cfg(not(any(unix, windows)))]
mod backend {
    use anyhow::{anyhow, Result};
    pub(super) fn secret() -> Result<super::Outcome> {
        Err(anyhow!("no keyring backend on this platform"))
    }
}

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

/// Runs `f` on a scratch thread so a keyring that never answers cannot hold up
/// startup. A timed out thread is left behind blocked on the keyring; it holds
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
    /// Our item exists but the collection holding it will not open. Only the
    /// Secret Service reports this; DPAPI has no locked state.
    Locked,
    /// The service answered and has nothing of ours, so one can be made.
    Missing,
    /// No keyring at all, or it failed in a way worth neither of the above.
    Unavailable(String),
}

pub fn keyring_status() -> KeyringStatus {
    let Some(result) = with_timeout(backend::secret) else {
        return KeyringStatus::Unavailable("the keyring did not answer in time".to_string());
    };

    match result {
        Ok(Outcome::Secret(bytes)) => KeyringStatus::Ready(Box::new(kek_from_secret(&bytes))),
        Ok(Outcome::Locked) => KeyringStatus::Locked,
        Err(e) => KeyringStatus::Unavailable(format!("{e:#}")),
    }
}

/// What a backend found, before it is turned into a [`KeyringStatus`].
///
/// `Locked` is dead code on Windows rather than absent from the enum: DPAPI
/// has no locked state, but the shape of the answer should not change with the
/// platform.
#[cfg_attr(not(unix), allow(dead_code))]
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
