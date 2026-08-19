//! PuTTY Private Key (PPK v2/v3) → OpenSSH PEM converter.
//!
//! Handles unencrypted and AES-256-CBC/GCM encrypted keys.
//! Supports ED25519, RSA, and ECDSA (P-256/P-384/P-521).

use anyhow::{anyhow, bail, Context, Result};
use base64::prelude::*;

// ── Public API ────────────────────────────────────────────────────────────────

/// Convert PPK file content to OpenSSH private key PEM.
pub fn ppk_to_openssh(content: &str, passphrase: Option<&str>) -> Result<String> {
    let ppk = parse_ppk(content)?;

    // The MAC key comes out of the same derivation as the decryption key, so
    // the two are found together or not at all.
    let (private_blob, mac_key) = if ppk.encryption == "none" {
        let key = match ppk.version {
            PpkVersion::V2 => v2_mac_key(""),
            PpkVersion::V3 => Vec::new(),
        };
        (ppk.private_data.clone(), key)
    } else {
        let pass = passphrase.context("Passphrase required for this PPK file")?;
        match ppk.version {
            PpkVersion::V2 => (decrypt_ppk_v2(&ppk.private_data, pass)?, v2_mac_key(pass)),
            PpkVersion::V3 => decrypt_ppk_v3(&ppk, pass)?,
        }
    };

    verify_mac(&ppk, &private_blob, &mac_key)?;

    match ppk.algorithm.as_str() {
        "ssh-ed25519" => build_ed25519(&ppk.public_data, &private_blob, &ppk.comment),
        "ssh-rsa"     => build_rsa(&ppk.public_data, &private_blob, &ppk.comment),
        a if a.starts_with("ecdsa-sha2-") => build_ecdsa(a, &ppk.public_data, &private_blob, &ppk.comment),
        other => Err(anyhow!("Unsupported PPK algorithm: {other}")),
    }
}

/// Quick algorithm detection from PPK content (no decryption needed).
pub fn ppk_detect_algorithm(content: &str) -> Option<String> {
    let ppk = parse_ppk(content).ok()?;
    Some(match ppk.algorithm.as_str() {
        "ssh-ed25519"          => "ED25519".into(),
        "ssh-rsa"              => "RSA".into(),
        "ecdsa-sha2-nistp256"  => "ECDSA P-256".into(),
        "ecdsa-sha2-nistp384"  => "ECDSA P-384".into(),
        "ecdsa-sha2-nistp521"  => "ECDSA P-521".into(),
        other                  => other.into(),
    })
}

pub fn is_ppk(content: &str) -> bool {
    content.starts_with("PuTTY-User-Key-File-")
}

// ── PPK parsing ───────────────────────────────────────────────────────────────

/// The two the parser accepts. An enum rather than a number so the one place
/// that branches on it has nothing left to say about anything else: as a u8 it
/// needed a third arm that could not be reached.
#[derive(Clone, Copy, PartialEq, Debug)]
enum PpkVersion {
    V2,
    V3,
}

struct PpkData {
    version:         PpkVersion,
    algorithm:       String,
    encryption:      String,
    comment:         String,
    public_data:     Vec<u8>,
    private_data:    Vec<u8>,
    // v3 KDF fields
    key_derivation:  Option<String>,
    argon2_memory:   Option<u32>,
    argon2_passes:   Option<u32>,
    argon2_parallism: Option<u32>,
    argon2_salt:     Option<Vec<u8>>,
    private_mac:     Option<String>,
}

fn parse_ppk(content: &str) -> Result<PpkData> {
    let mut lines = content.lines();

    let first = lines.next().context("Empty PPK file")?;
    let (version, algorithm) = if let Some(a) = first.strip_prefix("PuTTY-User-Key-File-3: ") {
        (PpkVersion::V3, a.trim().to_string())
    } else if let Some(a) = first.strip_prefix("PuTTY-User-Key-File-2: ") {
        (PpkVersion::V2, a.trim().to_string())
    } else if let Some(rest) = first.strip_prefix("PuTTY-User-Key-File-") {
        // A PPK, just not one this understands. Saying "not a PPK file" about a
        // key PuTTY wrote sends the reader looking in the wrong place.
        let v = rest.split(':').next().unwrap_or(rest).trim();
        bail!("Unsupported PPK version {v}; this reads version 2 and 3");
    } else {
        bail!("Not a PPK file");
    };

    let remaining: Vec<&str> = lines.collect();
    let mut idx = 0;

    let mut encryption   = "none".to_string();
    let mut comment      = String::new();
    let mut public_data  = Vec::new();
    let mut private_data = Vec::new();
    let mut key_derivation  = None;
    let mut argon2_memory   = None;
    let mut argon2_passes   = None;
    let mut argon2_parallism = None;
    let mut argon2_salt     = None;
    let mut private_mac     = None;

    while idx < remaining.len() {
        let line = remaining[idx];
        idx += 1;

        let (key, val) = match line.split_once(": ") {
            Some(kv) => kv,
            None     => continue,
        };

        match key {
            "Encryption"       => encryption = val.trim().to_string(),
            "Comment"          => comment    = val.to_string(),
            "Key-Derivation"   => key_derivation  = Some(val.trim().to_string()),
            "Argon2-Memory"    => argon2_memory    = val.trim().parse().ok(),
            "Argon2-Passes"    => argon2_passes    = val.trim().parse().ok(),
            "Argon2-Parallelism" => argon2_parallism = val.trim().parse().ok(),
            "Argon2-Salt"      => argon2_salt = from_hex(val.trim()).ok(),
            "Private-MAC"      => private_mac = Some(val.trim().to_string()),
            "Public-Lines"     => {
                let n: usize = val.trim().parse().context("Bad Public-Lines")?;
                public_data = read_base64_lines(&remaining, &mut idx, n)?;
            }
            "Private-Lines"    => {
                let n: usize = val.trim().parse().context("Bad Private-Lines")?;
                private_data = read_base64_lines(&remaining, &mut idx, n)?;
            }
            _ => {}
        }
    }

    Ok(PpkData {
        version, algorithm, encryption, comment,
        public_data, private_data,
        key_derivation, argon2_memory, argon2_passes, argon2_parallism, argon2_salt,
        private_mac,
    })
}

fn read_base64_lines(lines: &[&str], idx: &mut usize, n: usize) -> Result<Vec<u8>> {
    let mut b64 = String::new();
    for _ in 0..n {
        if *idx >= lines.len() { bail!("Unexpected EOF in PPK"); }
        b64.push_str(lines[*idx]);
        *idx += 1;
    }
    Ok(BASE64_STANDARD.decode(&b64)?)
}

// ── Decryption ────────────────────────────────────────────────────────────────

/// Ceilings on the Argon2 cost a PPK may ask for.
///
/// PuTTY's own defaults are 8 MiB and 13 passes, and it scales the passes to
/// hit a time target rather than the memory, so real files sit far below these.
/// The room above them is for a key someone deliberately made expensive, not
/// for a file that wants the machine.
const MAX_ARGON2_MEMORY_KIB: u32 = 1024 * 1024;
const MAX_ARGON2_PASSES: u32 = 64;

// ── Integrity ─────────────────────────────────────────────────────────────────

/// The bytes a PPK's `Private-MAC` is taken over.
///
/// Five SSH strings, each a big-endian length followed by its bytes. The
/// private part is the *plaintext*, so for an encrypted key this can only be
/// built after decrypting, which is what makes the MAC a passphrase check as
/// well as a tamper check.
fn mac_input(ppk: &PpkData, private_plain: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    for field in [
        ppk.algorithm.as_bytes(),
        ppk.encryption.as_bytes(),
        ppk.comment.as_bytes(),
        &ppk.public_data,
        private_plain,
    ] {
        out.extend_from_slice(&(field.len() as u32).to_be_bytes());
        out.extend_from_slice(field);
    }
    out
}

/// The v2 MAC key: SHA-1 over a fixed string and the passphrase.
///
/// An unencrypted v2 key uses the same derivation with an empty passphrase
/// rather than an empty key, which is why this is called in both cases.
fn v2_mac_key(passphrase: &str) -> Vec<u8> {
    use sha1::{Digest, Sha1};
    Sha1::new()
        .chain_update(b"putty-private-key-file-mac-key")
        .chain_update(passphrase.as_bytes())
        .finalize()
        .to_vec()
}

/// Checks `Private-MAC` against the decrypted key.
///
/// Nothing checked this before. Two things follow from that. A wrong
/// passphrase produced plausible-looking garbage that failed further along as
/// a parse error, telling the user their file was corrupt when it was their
/// typing; and a file altered in transit was decrypted and used without
/// anything noticing, which is the whole reason the field is in the format.
fn verify_mac(ppk: &PpkData, private_plain: &[u8], mac_key: &[u8]) -> Result<()> {
    use hmac::{Hmac, Mac};

    let expected = ppk
        .private_mac
        .as_deref()
        .context("PPK has no Private-MAC line")?;
    let expected = from_hex(expected).context("Private-MAC is not hex")?;
    let data = mac_input(ppk, private_plain);

    // verify_slice compares in constant time and rejects a wrong length.
    let ok = match ppk.version {
        PpkVersion::V2 => Hmac::<sha1::Sha1>::new_from_slice(mac_key)
            .expect("HMAC takes a key of any length")
            .chain_update(&data)
            .verify_slice(&expected)
            .is_ok(),
        PpkVersion::V3 => Hmac::<sha2::Sha256>::new_from_slice(mac_key)
            .expect("HMAC takes a key of any length")
            .chain_update(&data)
            .verify_slice(&expected)
            .is_ok(),
    };

    if ok {
        return Ok(());
    }
    if ppk.encryption == "none" {
        bail!("PPK failed its integrity check; the file has been modified");
    }
    bail!("Wrong passphrase, or the PPK file has been modified");
}

fn decrypt_ppk_v2(data: &[u8], passphrase: &str) -> Result<Vec<u8>> {
    use aes::Aes256;
    use cbc::cipher::{BlockDecryptMut, KeyIvInit, block_padding::NoPadding};
    use sha1::{Digest, Sha1};

    // Key derivation: SHA1(seq_be32 || passphrase), first 32 bytes
    let h0 = Sha1::new()
        .chain_update(b"\x00\x00\x00\x00")
        .chain_update(passphrase.as_bytes())
        .finalize();
    let h1 = Sha1::new()
        .chain_update(b"\x00\x00\x00\x01")
        .chain_update(passphrase.as_bytes())
        .finalize();
    let mut key = [0u8; 32];
    key[..20].copy_from_slice(&h0);
    key[20..].copy_from_slice(&h1[..12]);

    let iv = [0u8; 16];
    let mut buf = data.to_vec();
    if !buf.len().is_multiple_of(16) {
        buf.resize(buf.len() + (16 - buf.len() % 16), 0);
    }
    cbc::Decryptor::<Aes256>::new(&key.into(), &iv.into())
        .decrypt_padded_mut::<NoPadding>(&mut buf)
        .map_err(|e| anyhow!("AES decrypt error: {e:?}"))?;
    buf.truncate(data.len());
    Ok(buf)
}

fn decrypt_ppk_v3(ppk: &PpkData, passphrase: &str) -> Result<(Vec<u8>, Vec<u8>)> {
    use aes::Aes256;
    use cbc::cipher::{BlockDecryptMut, KeyIvInit, block_padding::NoPadding};
    use argon2::{Algorithm as Argon2Alg, Argon2, Params, Version};

    let flavor = ppk.key_derivation.as_deref().unwrap_or("Argon2id");
    let memory  = ppk.argon2_memory.context("Missing Argon2-Memory")?;
    let passes  = ppk.argon2_passes.context("Missing Argon2-Passes")?;
    let parallel = ppk.argon2_parallism.context("Missing Argon2-Parallelism")?;
    let salt    = ppk.argon2_salt.as_deref().context("Missing Argon2-Salt")?;

    // The cost is read out of the file, so it is whatever the file's author
    // chose. argon2's own ceiling is 256 GiB, which is no ceiling at all: a
    // header asking for 8 GiB is eight characters to write and enough to end
    // the process. Refusing is the only safe answer, because the work has to
    // happen before anything can tell whether the passphrase was even right.
    if memory > MAX_ARGON2_MEMORY_KIB {
        bail!(
            "PPK asks for {} MiB of memory to open, more than the {} MiB limit",
            memory / 1024,
            MAX_ARGON2_MEMORY_KIB / 1024,
        );
    }
    if passes > MAX_ARGON2_PASSES {
        bail!("PPK asks for {passes} Argon2 passes, more than the {MAX_ARGON2_PASSES} limit");
    }

    let alg = match flavor {
        "Argon2id" => Argon2Alg::Argon2id,
        "Argon2i"  => Argon2Alg::Argon2i,
        "Argon2d"  => Argon2Alg::Argon2d,
        other      => return Err(anyhow!("Unknown Argon2 variant: {other}")),
    };

    // 80 bytes: 32 key + 16 IV + 32 MAC key
    let out_len = 80usize;
    let params = Params::new(memory, passes, parallel, Some(out_len))
        .map_err(|e| anyhow!("Argon2 parameters: {e}"))?;
    let argon2 = Argon2::new(alg, Version::V0x13, params);
    let mut key_material = vec![0u8; out_len];
    argon2
        .hash_password_into(passphrase.as_bytes(), salt, &mut key_material)
        .map_err(|e| anyhow!("Argon2 key derivation: {e}"))?;

    let (aes_key, rest) = key_material.split_at(32);
    let iv = &rest[..16];
    let mac_key = rest[16..].to_vec();

    let mut buf = ppk.private_data.to_vec();
    if !buf.len().is_multiple_of(16) {
        buf.resize(buf.len() + (16 - buf.len() % 16), 0);
    }
    cbc::Decryptor::<Aes256>::new(aes_key.into(), iv.into())
        .decrypt_padded_mut::<NoPadding>(&mut buf)
        .map_err(|e| anyhow!("AES decrypt error: {e:?}"))?;
    buf.truncate(ppk.private_data.len());
    Ok((buf, mac_key))
}

// ── SSH wire format helpers ───────────────────────────────────────────────────

fn ssh_read_u32(data: &[u8], pos: &mut usize) -> Result<u32> {
    if *pos + 4 > data.len() { bail!("SSH wire: EOF reading u32"); }
    let v = u32::from_be_bytes(data[*pos..*pos + 4].try_into().unwrap());
    *pos += 4;
    Ok(v)
}

fn ssh_read_bytes(data: &[u8], pos: &mut usize) -> Result<Vec<u8>> {
    let len = ssh_read_u32(data, pos)? as usize;
    if *pos + len > data.len() { bail!("SSH wire: EOF reading string"); }
    let v = data[*pos..*pos + len].to_vec();
    *pos += len;
    Ok(v)
}

fn ssh_read_mpint(data: &[u8], pos: &mut usize) -> Result<Vec<u8>> {
    let bytes = ssh_read_bytes(data, pos)?;
    // strip leading zero sign byte
    Ok(match bytes.iter().position(|&b| b != 0) {
        Some(i) => bytes[i..].to_vec(),
        None    => vec![],
    })
}

fn ssh_write_u32(buf: &mut Vec<u8>, v: u32) {
    buf.extend_from_slice(&v.to_be_bytes());
}

fn ssh_write_bytes(buf: &mut Vec<u8>, data: &[u8]) {
    ssh_write_u32(buf, data.len() as u32);
    buf.extend_from_slice(data);
}

fn ssh_write_mpint(buf: &mut Vec<u8>, data: &[u8]) {
    // strip leading zeros
    let stripped = match data.iter().position(|&b| b != 0) {
        Some(i) => &data[i..],
        None    => &data[..0],
    };
    if stripped.is_empty() {
        ssh_write_u32(buf, 0);
    } else if stripped[0] & 0x80 != 0 {
        ssh_write_u32(buf, stripped.len() as u32 + 1);
        buf.push(0x00);
        buf.extend_from_slice(stripped);
    } else {
        ssh_write_bytes(buf, stripped);
    }
}

// ── OpenSSH PEM builder ───────────────────────────────────────────────────────

fn build_openssh_pem(public_blob: &[u8], private_key_data: &[u8], comment: &str) -> String {
    let mut buf = Vec::new();
    buf.extend_from_slice(b"openssh-key-v1\0");
    ssh_write_bytes(&mut buf, b"none");        // ciphername
    ssh_write_bytes(&mut buf, b"none");        // kdfname
    ssh_write_bytes(&mut buf, b"");            // kdfoptions
    ssh_write_u32(&mut buf, 1);                // num_keys
    ssh_write_bytes(&mut buf, public_blob);

    let checkint: u32 = 0x_dead_beef;
    let mut priv_section = Vec::new();
    ssh_write_u32(&mut priv_section, checkint);
    ssh_write_u32(&mut priv_section, checkint);
    priv_section.extend_from_slice(private_key_data);
    ssh_write_bytes(&mut priv_section, comment.as_bytes());
    let mut pad = 1u8;
    while priv_section.len() % 8 != 0 { priv_section.push(pad); pad = pad.wrapping_add(1); }

    ssh_write_bytes(&mut buf, &priv_section);

    let b64 = BASE64_STANDARD.encode(&buf);
    let lines: String = b64.as_bytes()
        .chunks(70)
        .map(|c| std::str::from_utf8(c).unwrap())
        .collect::<Vec<_>>()
        .join("\n");
    format!("-----BEGIN OPENSSH PRIVATE KEY-----\n{lines}\n-----END OPENSSH PRIVATE KEY-----\n")
}

// ── Key-specific builders ─────────────────────────────────────────────────────

fn build_ed25519(public_data: &[u8], private_blob: &[u8], comment: &str) -> Result<String> {
    // PPK public blob:  string("ssh-ed25519") + string(pub[32])
    // PPK private blob: string(seed[32])  — PuTTY stores only the 32-byte seed
    let mut pos = 0;
    let _algo = ssh_read_bytes(public_data, &mut pos)?;
    let pub_bytes = ssh_read_bytes(public_data, &mut pos)?;
    if pub_bytes.len() != 32 { bail!("ED25519 public key must be 32 bytes"); }

    let mut ppos = 0;
    let seed_bytes = ssh_read_bytes(private_blob, &mut ppos)?;
    if seed_bytes.len() != 32 { bail!("ED25519 private seed must be 32 bytes"); }

    // OpenSSH private data: string("ssh-ed25519") + string(pub32) + string(seed32 || pub32)
    let mut combined = Vec::with_capacity(64);
    combined.extend_from_slice(&seed_bytes);
    combined.extend_from_slice(&pub_bytes);

    let mut pk_data = Vec::new();
    ssh_write_bytes(&mut pk_data, b"ssh-ed25519");
    ssh_write_bytes(&mut pk_data, &pub_bytes);
    ssh_write_bytes(&mut pk_data, &combined);

    Ok(build_openssh_pem(public_data, &pk_data, comment))
}

fn build_rsa(public_data: &[u8], private_blob: &[u8], comment: &str) -> Result<String> {
    // PPK public blob:  string("ssh-rsa") + mpint(e) + mpint(n)
    // PPK private blob: mpint(d) + mpint(p) + mpint(q) + mpint(iqmp)
    let mut pos = 0;
    let _algo = ssh_read_bytes(public_data, &mut pos)?;
    let e    = ssh_read_mpint(public_data, &mut pos)?;
    let n    = ssh_read_mpint(public_data, &mut pos)?;

    let mut ppos = 0;
    let d    = ssh_read_mpint(private_blob, &mut ppos)?;
    let p    = ssh_read_mpint(private_blob, &mut ppos)?;
    let q    = ssh_read_mpint(private_blob, &mut ppos)?;
    let iqmp = ssh_read_mpint(private_blob, &mut ppos)?;

    // OpenSSH private data: string("ssh-rsa") + mpint(n) + mpint(e) + mpint(d) + mpint(iqmp) + mpint(p) + mpint(q)
    let mut pk_data = Vec::new();
    ssh_write_bytes(&mut pk_data, b"ssh-rsa");
    ssh_write_mpint(&mut pk_data, &n);
    ssh_write_mpint(&mut pk_data, &e);
    ssh_write_mpint(&mut pk_data, &d);
    ssh_write_mpint(&mut pk_data, &iqmp);
    ssh_write_mpint(&mut pk_data, &p);
    ssh_write_mpint(&mut pk_data, &q);

    Ok(build_openssh_pem(public_data, &pk_data, comment))
}

fn build_ecdsa(algorithm: &str, public_data: &[u8], private_blob: &[u8], comment: &str) -> Result<String> {
    // PPK public blob:  string(algo) + string(curve) + string(point)
    // PPK private blob: mpint(scalar)
    let mut pos = 0;
    let _algo  = ssh_read_bytes(public_data, &mut pos)?;
    let curve  = ssh_read_bytes(public_data, &mut pos)?;
    let point  = ssh_read_bytes(public_data, &mut pos)?;

    let mut ppos = 0;
    let scalar = ssh_read_mpint(private_blob, &mut ppos)?;

    // OpenSSH private data: string(algo) + string(curve) + string(point) + mpint(scalar)
    let mut pk_data = Vec::new();
    ssh_write_bytes(&mut pk_data, algorithm.as_bytes());
    ssh_write_bytes(&mut pk_data, &curve);
    ssh_write_bytes(&mut pk_data, &point);
    ssh_write_mpint(&mut pk_data, &scalar);

    Ok(build_openssh_pem(public_data, &pk_data, comment))
}

// ── Utilities ─────────────────────────────────────────────────────────────────

fn from_hex(s: &str) -> Result<Vec<u8>> {
    if !s.len().is_multiple_of(2) { bail!("Odd hex length"); }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| anyhow!("Invalid hex char")))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASSPHRASE: &str = include_str!("testdata/PASSPHRASE");

    /// Converts, then reads the result back and returns its public key in
    /// `authorized_keys` form.
    ///
    /// Parsing the output is the point: a converter can emit something that
    /// looks like a PEM and is not a key, and only a reader that does not
    /// share its assumptions will say so.
    fn converted_public_key(ppk: &str, passphrase: Option<&str>) -> String {
        let pem = ppk_to_openssh(ppk, passphrase).expect("conversion failed");
        let key = ssh_key::PrivateKey::from_openssh(&pem).expect("output is not an OpenSSH key");
        key.public_key().to_openssh().expect("public key would not render")
    }

    /// What puttygen itself says the file holds, minus the trailing comment.
    fn expected_public_key(pub_file: &str) -> String {
        let line = pub_file.lines().find(|l| !l.starts_with("---") && !l.contains(": ")).unwrap_or("");
        line.split_whitespace().take(2).collect::<Vec<_>>().join(" ")
    }

    fn check(ppk: &str, pub_file: &str, passphrase: Option<&str>) {
        let got = converted_public_key(ppk, passphrase);
        let want = expected_public_key(pub_file);
        assert_eq!(
            got.split_whitespace().take(2).collect::<Vec<_>>().join(" "),
            want,
            "converted key does not match the one PuTTY says the file holds",
        );
    }

    #[test]
    fn ed25519_v3_unencrypted() {
        check(include_str!("testdata/ed25519_v3.ppk"), include_str!("testdata/ed25519_v3.pub"), None);
    }

    #[test]
    fn ed25519_v2_unencrypted() {
        check(include_str!("testdata/ed25519_v2.ppk"), include_str!("testdata/ed25519_v2.pub"), None);
    }

    #[test]
    fn rsa_v3_unencrypted() {
        check(include_str!("testdata/rsa_v3.ppk"), include_str!("testdata/rsa_v3.pub"), None);
    }

    #[test]
    fn ecdsa_p256_v3_unencrypted() {
        check(include_str!("testdata/ecdsa256_v3.ppk"), include_str!("testdata/ecdsa256_v3.pub"), None);
    }

    /// v3 encryption: Argon2id, then AES-256-CBC.
    #[test]
    fn ed25519_v3_encrypted() {
        check(
            include_str!("testdata/ed25519_v3_enc.ppk"),
            include_str!("testdata/ed25519_v3_enc.pub"),
            Some(PASSPHRASE),
        );
    }

    /// v2 encryption derives its key by SHA-1 instead, a different path.
    #[test]
    fn rsa_v2_encrypted() {
        check(
            include_str!("testdata/rsa_v2_enc.ppk"),
            include_str!("testdata/rsa_v2_enc.pub"),
            Some(PASSPHRASE),
        );
    }

    #[test]
    fn the_algorithm_is_readable_without_decrypting() {
        let cases = [
            ("testdata/ed25519_v3.ppk", "ED25519"),
            ("testdata/rsa_v3.ppk", "RSA"),
            ("testdata/ecdsa256_v3.ppk", "ECDSA P-256"),
        ];
        let files = [
            include_str!("testdata/ed25519_v3.ppk"),
            include_str!("testdata/rsa_v3.ppk"),
            include_str!("testdata/ecdsa256_v3.ppk"),
        ];
        for ((name, want), content) in cases.iter().zip(files) {
            assert_eq!(ppk_detect_algorithm(content).as_deref(), Some(*want), "{name}");
        }
        // Encrypted too: the header is in the clear.
        assert_eq!(
            ppk_detect_algorithm(include_str!("testdata/ed25519_v3_enc.ppk")).as_deref(),
            Some("ED25519"),
        );
    }

    #[test]
    fn ppk_files_are_recognised_and_others_are_not() {
        assert!(is_ppk(include_str!("testdata/ed25519_v3.ppk")));
        assert!(!is_ppk("-----BEGIN OPENSSH PRIVATE KEY-----\n"));
        assert!(!is_ppk(""));
    }

    // ── Failures ────────────────────────────────────────────────────────────

    #[test]
    fn an_encrypted_key_without_a_passphrase_says_so() {
        let e = ppk_to_openssh(include_str!("testdata/ed25519_v3_enc.ppk"), None).unwrap_err();
        assert!(format!("{e:#}").contains("Passphrase required"), "{e:#}");
    }

    /// The wrong passphrase must fail rather than hand back a key that will be
    /// rejected later by a server, where the cause would be much harder to see.
    ///
    /// It must also fail *as* a wrong passphrase. Before the MAC was checked
    /// this came out as whatever the garbage plaintext happened to break, which
    /// told the user their file was corrupt when it was their typing.
    #[test]
    fn the_wrong_passphrase_is_rejected() {
        let e = ppk_to_openssh(include_str!("testdata/ed25519_v3_enc.ppk"), Some("not it"))
            .unwrap_err();
        assert!(format!("{e:#}").contains("Wrong passphrase"), "{e:#}");
    }

    /// The MAC covers the header as well as the key, so changing the comment
    /// on a file you did not write is caught. Both versions, because they hash
    /// with different algorithms under differently derived keys.
    #[test]
    fn a_modified_ppk_is_refused() {
        for (name, original) in [
            ("v3", include_str!("testdata/ed25519_v3.ppk")),
            ("v2", include_str!("testdata/ed25519_v2.ppk")),
        ] {
            assert!(ppk_to_openssh(original, None).is_ok(), "{name} fixture should open");

            let retitled = original.replace("Comment: ", "Comment: not-");
            assert_ne!(retitled, original, "{name}: the edit did not apply");
            let e = ppk_to_openssh(&retitled, None).unwrap_err();
            assert!(
                format!("{e:#}").contains("has been modified"),
                "{name} accepted an edited comment: {e:#}",
            );

            let no_mac: String = original
                .lines()
                .filter(|l| !l.starts_with("Private-MAC:"))
                .map(|l| format!("{l}\n"))
                .collect();
            let e = ppk_to_openssh(&no_mac, None).unwrap_err();
            assert!(format!("{e:#}").contains("no Private-MAC"), "{name}: {e:#}");
        }
    }

    /// A cost the file asks for is work this machine has to do before it can
    /// tell whether the passphrase was right, so it has to be refused up front
    /// rather than attempted and abandoned.
    #[test]
    fn a_ppk_demanding_absurd_argon2_cost_is_refused_before_doing_the_work() {
        let base = include_str!("testdata/ed25519_v3_enc.ppk");

        let greedy = base.replace("Argon2-Memory: 8192", "Argon2-Memory: 8388608");
        let e = ppk_to_openssh(&greedy, Some(PASSPHRASE)).unwrap_err();
        assert!(format!("{e:#}").contains("8192 MiB"), "{e:#}");

        let slow = base.replace("Argon2-Passes: 21", "Argon2-Passes: 4000000000");
        let e = ppk_to_openssh(&slow, Some(PASSPHRASE)).unwrap_err();
        assert!(format!("{e:#}").contains("Argon2 passes"), "{e:#}");

        // The limits have to leave real files alone, so the same fixture at
        // its own cost still opens.
        assert!(ppk_to_openssh(base, Some(PASSPHRASE)).is_ok());
    }

    #[test]
    fn something_that_is_not_a_ppk_is_refused() {
        let e = ppk_to_openssh("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n", None).unwrap_err();
        assert!(format!("{e:#}").contains("Not a PPK file"), "{e:#}");
    }

    #[test]
    fn a_truncated_file_is_refused_rather_than_half_read() {
        let full = include_str!("testdata/ed25519_v3.ppk");
        let half: String = full.lines().take(4).collect::<Vec<_>>().join("\n");
        assert!(ppk_to_openssh(&half, None).is_err());
    }

    /// A newer PPK is a PPK, and saying otherwise sends the reader looking in
    /// the wrong place.
    #[test]
    fn a_newer_ppk_version_is_named_rather_than_disowned() {
        let bad = include_str!("testdata/ed25519_v3.ppk")
            .replace("PuTTY-User-Key-File-3", "PuTTY-User-Key-File-9");
        let e = ppk_to_openssh(&bad, None).unwrap_err();
        let shown = format!("{e:#}");
        assert!(shown.contains('9'), "{shown}");
        assert!(!shown.contains("Not a PPK"), "{shown}");
    }

    #[test]
    fn hex_is_read_in_pairs() {
        assert_eq!(from_hex("00ff10").unwrap(), vec![0x00, 0xff, 0x10]);
        assert_eq!(from_hex("").unwrap(), Vec::<u8>::new());
        assert!(from_hex("abc").is_err(), "odd length");
        assert!(from_hex("zz").is_err(), "not hex");
    }
}
