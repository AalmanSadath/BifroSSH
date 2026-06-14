/// PuTTY Private Key (PPK v2/v3) → OpenSSH PEM converter.
///
/// Handles unencrypted and AES-256-CBC/GCM encrypted keys.
/// Supports ED25519, RSA, and ECDSA (P-256/P-384/P-521).

use base64::prelude::*;

// ── Public API ────────────────────────────────────────────────────────────────

/// Convert PPK file content to OpenSSH private key PEM.
pub fn ppk_to_openssh(content: &str, passphrase: Option<&str>) -> Result<String, String> {
    let ppk = parse_ppk(content)?;

    let private_blob = if ppk.encryption == "none" {
        ppk.private_data.clone()
    } else {
        let pass = passphrase.ok_or("Passphrase required for this PPK file")?;
        match ppk.version {
            2 => decrypt_ppk_v2(&ppk.private_data, pass)?,
            3 => decrypt_ppk_v3(&ppk, pass)?,
            v => return Err(format!("Unsupported PPK version {v}")),
        }
    };

    match ppk.algorithm.as_str() {
        "ssh-ed25519" => build_ed25519(&ppk.public_data, &private_blob, &ppk.comment),
        "ssh-rsa"     => build_rsa(&ppk.public_data, &private_blob, &ppk.comment),
        a if a.starts_with("ecdsa-sha2-") => build_ecdsa(a, &ppk.public_data, &private_blob, &ppk.comment),
        other => Err(format!("Unsupported PPK algorithm: {other}")),
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

struct PpkData {
    version:         u8,
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
}

fn parse_ppk(content: &str) -> Result<PpkData, String> {
    let mut lines = content.lines();

    let first = lines.next().ok_or("Empty PPK file")?;
    let (version, algorithm) = if let Some(a) = first.strip_prefix("PuTTY-User-Key-File-3: ") {
        (3u8, a.trim().to_string())
    } else if let Some(a) = first.strip_prefix("PuTTY-User-Key-File-2: ") {
        (2u8, a.trim().to_string())
    } else {
        return Err("Not a PPK file".into());
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
            "Public-Lines"     => {
                let n: usize = val.trim().parse().map_err(|_| "Bad Public-Lines")?;
                public_data = read_base64_lines(&remaining, &mut idx, n)?;
            }
            "Private-Lines"    => {
                let n: usize = val.trim().parse().map_err(|_| "Bad Private-Lines")?;
                private_data = read_base64_lines(&remaining, &mut idx, n)?;
            }
            _ => {}
        }
    }

    Ok(PpkData {
        version, algorithm, encryption, comment,
        public_data, private_data,
        key_derivation, argon2_memory, argon2_passes, argon2_parallism, argon2_salt,
    })
}

fn read_base64_lines(lines: &[&str], idx: &mut usize, n: usize) -> Result<Vec<u8>, String> {
    let mut b64 = String::new();
    for _ in 0..n {
        if *idx >= lines.len() { return Err("Unexpected EOF in PPK".into()); }
        b64.push_str(lines[*idx]);
        *idx += 1;
    }
    BASE64_STANDARD.decode(&b64).map_err(|e| e.to_string())
}

// ── Decryption ────────────────────────────────────────────────────────────────

fn decrypt_ppk_v2(data: &[u8], passphrase: &str) -> Result<Vec<u8>, String> {
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
    if buf.len() % 16 != 0 {
        buf.resize(buf.len() + (16 - buf.len() % 16), 0);
    }
    cbc::Decryptor::<Aes256>::new(&key.into(), &iv.into())
        .decrypt_padded_mut::<NoPadding>(&mut buf)
        .map_err(|e| format!("AES decrypt error: {e:?}"))?;
    buf.truncate(data.len());
    Ok(buf)
}

fn decrypt_ppk_v3(ppk: &PpkData, passphrase: &str) -> Result<Vec<u8>, String> {
    use aes::Aes256;
    use cbc::cipher::{BlockDecryptMut, KeyIvInit, block_padding::NoPadding};
    use argon2::{Algorithm as Argon2Alg, Argon2, Params, Version};

    let flavor = ppk.key_derivation.as_deref().unwrap_or("Argon2id");
    let memory  = ppk.argon2_memory.ok_or("Missing Argon2-Memory")?;
    let passes  = ppk.argon2_passes.ok_or("Missing Argon2-Passes")?;
    let parallel = ppk.argon2_parallism.ok_or("Missing Argon2-Parallelism")?;
    let salt    = ppk.argon2_salt.as_deref().ok_or("Missing Argon2-Salt")?;

    let alg = match flavor {
        "Argon2id" => Argon2Alg::Argon2id,
        "Argon2i"  => Argon2Alg::Argon2i,
        "Argon2d"  => Argon2Alg::Argon2d,
        other      => return Err(format!("Unknown Argon2 variant: {other}")),
    };

    // 80 bytes: 32 key + 16 IV + 32 MAC key
    let out_len = 80usize;
    let params = Params::new(memory, passes, parallel, Some(out_len))
        .map_err(|e| e.to_string())?;
    let argon2 = Argon2::new(alg, Version::V0x13, params);
    let mut key_material = vec![0u8; out_len];
    argon2.hash_password_into(passphrase.as_bytes(), salt, &mut key_material)
        .map_err(|e| e.to_string())?;

    let (aes_key, rest) = key_material.split_at(32);
    let iv = &rest[..16];

    let mut buf = ppk.private_data.to_vec();
    if buf.len() % 16 != 0 {
        buf.resize(buf.len() + (16 - buf.len() % 16), 0);
    }
    cbc::Decryptor::<Aes256>::new(aes_key.into(), iv.into())
        .decrypt_padded_mut::<NoPadding>(&mut buf)
        .map_err(|e| format!("AES decrypt error: {e:?}"))?;
    buf.truncate(ppk.private_data.len());
    Ok(buf)
}

// ── SSH wire format helpers ───────────────────────────────────────────────────

fn ssh_read_u32(data: &[u8], pos: &mut usize) -> Result<u32, String> {
    if *pos + 4 > data.len() { return Err("SSH wire: EOF reading u32".into()); }
    let v = u32::from_be_bytes(data[*pos..*pos + 4].try_into().unwrap());
    *pos += 4;
    Ok(v)
}

fn ssh_read_bytes(data: &[u8], pos: &mut usize) -> Result<Vec<u8>, String> {
    let len = ssh_read_u32(data, pos)? as usize;
    if *pos + len > data.len() { return Err("SSH wire: EOF reading string".into()); }
    let v = data[*pos..*pos + len].to_vec();
    *pos += len;
    Ok(v)
}

fn ssh_read_mpint(data: &[u8], pos: &mut usize) -> Result<Vec<u8>, String> {
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

fn build_ed25519(public_data: &[u8], private_blob: &[u8], comment: &str) -> Result<String, String> {
    // PPK public blob:  string("ssh-ed25519") + string(pub[32])
    // PPK private blob: string(seed[32])  — PuTTY stores only the 32-byte seed
    let mut pos = 0;
    let _algo = ssh_read_bytes(public_data, &mut pos)?;
    let pub_bytes = ssh_read_bytes(public_data, &mut pos)?;
    if pub_bytes.len() != 32 { return Err("ED25519 public key must be 32 bytes".into()); }

    let mut ppos = 0;
    let seed_bytes = ssh_read_bytes(private_blob, &mut ppos)?;
    if seed_bytes.len() != 32 { return Err("ED25519 private seed must be 32 bytes".into()); }

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

fn build_rsa(public_data: &[u8], private_blob: &[u8], comment: &str) -> Result<String, String> {
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

fn build_ecdsa(algorithm: &str, public_data: &[u8], private_blob: &[u8], comment: &str) -> Result<String, String> {
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

fn from_hex(s: &str) -> Result<Vec<u8>, String> {
    if s.len() % 2 != 0 { return Err("Odd hex length".into()); }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(|_| "Invalid hex char".to_string()))
        .collect()
}
