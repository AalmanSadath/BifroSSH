//! The Windows backend: a random secret sealed with DPAPI.
//!
//! Windows has no Secret Service, and its Credential Manager stores a
//! credential the user can read back from Control Panel. DPAPI is the closer
//! match to what the Linux side buys: `CryptProtectData` seals a blob against
//! the logged-on Windows account, so the sealed form on disk is worthless to
//! any other account and to the same account on another machine, and unsealing
//! it needs no prompt and no running service.
//!
//! The sealed blob lives beside the vault rather than in a registry key, so
//! everything BifroSSH owns is in one directory and the existing backup and
//! export machinery already knows where to look.
//!
//! What this does not buy, and the Secret Service does not buy either: another
//! process running as the same user can call `CryptUnprotectData` on the same
//! blob with the same entropy and get the same secret. Nothing short of a
//! passphrase the user types stops that, which is exactly the fallback
//! `keystore` already offers.

use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use anyhow::{anyhow, Context, Result};
use rand::RngCore;
use windows::core::PCWSTR;
use windows::Win32::Foundation::{HLOCAL, LocalFree};
use windows::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
};

use super::Outcome;

/// The sealed secret, under the data directory.
const BLOB_FILE: &str = "dpapi.bin";

/// Extra entropy mixed into the seal. Without it any process on the account
/// could unseal the blob by handing DPAPI the bytes; with it, it also has to
/// know this string. That is obfuscation rather than a boundary, since the
/// string is in the binary, but it does stop an unrelated app that stumbles
/// across the file from unsealing it by accident.
const ENTROPY: &[u8] = b"bifrossh-dpapi-v1";

/// Matches the length the Secret portal hands back on Linux, so both platforms
/// feed `kek_from_secret` the same amount of material.
const SECRET_LEN: usize = 64;

pub(super) fn secret() -> Result<Outcome> {
    let path = crate::store::get_data_dir()?.join(BLOB_FILE);

    match fs::read(&path) {
        Ok(blob) => unprotect(&blob)
            .with_context(|| {
                format!(
                    "unsealing {}. It was sealed by a different Windows account, \
                     or restored from another machine.",
                    path.display()
                )
            })
            .map(Outcome::Secret),
        Err(e) if e.kind() == ErrorKind::NotFound => create(&path).map(Outcome::Secret),
        Err(e) => Err(e).with_context(|| format!("reading {}", path.display())),
    }
}

/// Seals a fresh secret, refusing to overwrite one that appeared meanwhile.
///
/// `write_new_private` is the whole guard: two instances starting at once would
/// otherwise each seal their own secret and the second would strand every
/// wrapper written against the first. The loser re-reads instead.
fn create(path: &Path) -> Result<Vec<u8>> {
    let mut fresh = vec![0u8; SECRET_LEN];
    rand::thread_rng().fill_bytes(&mut fresh);

    let sealed = protect(&fresh).context("sealing a new key with DPAPI")?;
    match crate::store::write_new_private(path, &sealed) {
        Ok(()) => Ok(fresh),
        Err(e) if e.kind() == ErrorKind::AlreadyExists => {
            let blob = fs::read(path).with_context(|| format!("reading {}", path.display()))?;
            unprotect(&blob).with_context(|| format!("unsealing {}", path.display()))
        }
        Err(e) => Err(e).with_context(|| format!("writing {}", path.display())),
    }
}

/// A borrowed slice as the blob DPAPI wants. The pointer is cast away from
/// const because the API takes a mutable field it does not write through.
fn blob(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
    CRYPT_INTEGER_BLOB {
        cbData: bytes.len() as u32,
        pbData: bytes.as_ptr() as *mut u8,
    }
}

/// Copies out an output blob and frees what DPAPI allocated for it.
///
/// # Safety
///
/// `out` must be an output blob DPAPI filled in and has not yet been freed.
unsafe fn take(out: CRYPT_INTEGER_BLOB) -> Vec<u8> {
    let bytes = std::slice::from_raw_parts(out.pbData, out.cbData as usize).to_vec();
    let _ = LocalFree(Some(HLOCAL(out.pbData as *mut _)));
    bytes
}

fn protect(plain: &[u8]) -> Result<Vec<u8>> {
    let mut out = CRYPT_INTEGER_BLOB::default();
    // UI_FORBIDDEN because this runs on the startup path: a DPAPI prompt there
    // would be a window the user cannot explain appearing before ours does.
    unsafe {
        CryptProtectData(
            &blob(plain),
            PCWSTR::null(),
            Some(&blob(ENTROPY)),
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
        .map_err(|e| anyhow!("CryptProtectData failed: {e}"))?;
        Ok(take(out))
    }
}

fn unprotect(sealed: &[u8]) -> Result<Vec<u8>> {
    let mut out = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &blob(sealed),
            None,
            Some(&blob(ENTROPY)),
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut out,
        )
        .map_err(|e| anyhow!("CryptUnprotectData failed: {e}"))?;
        Ok(take(out))
    }
}
