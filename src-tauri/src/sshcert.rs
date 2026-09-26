//! OpenSSH user certificates: a key's public half signed by a certificate
//! authority, which a server set up with `TrustedUserCAKeys` accepts in place
//! of an `authorized_keys` line.
//!
//! The certificate is public, the text of an `id_*-cert.pub` file. It is only
//! of use together with its own private key, which is why it is kept on the
//! key's entry rather than on its own.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use ssh_key::{certificate::CertType, public::KeyData, Algorithm, Certificate, HashAlg};

/// What the Keychain shows about a certificate.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct CertInfo {
    pub key_id: String,
    /// The user names it is good for. Empty means any, which a CA rarely
    /// issues but can.
    pub principals: Vec<String>,
    /// Seconds since the epoch. `valid_before` is `u64::MAX` for "forever",
    /// sent as None so the frontend does not have to know that.
    pub valid_after: u64,
    pub valid_before: Option<u64>,
    /// The CA that signed it, as `SHA256:…`.
    pub ca_fingerprint: String,
    /// RSA certificates are sent under the old ssh-rsa-cert-v01 name, which
    /// OpenSSH 8.8 and later refuse by default; the Keychain says so.
    pub rsa: bool,
}

/// Reads certificate text: the whole of a `-cert.pub` file.
pub fn parse(text: &str) -> Result<Certificate> {
    Certificate::from_openssh(text.trim()).map_err(|e| anyhow!("This is not an OpenSSH certificate ({e})"))
}

pub fn inspect(cert: &Certificate) -> CertInfo {
    CertInfo {
        key_id: cert.key_id().to_string(),
        principals: cert.valid_principals().to_vec(),
        valid_after: cert.valid_after(),
        valid_before: (cert.valid_before() != u64::MAX).then(|| cert.valid_before()),
        ca_fingerprint: cert.signature_key().fingerprint(HashAlg::Sha256).to_string(),
        rsa: matches!(cert.algorithm(), Algorithm::Rsa { .. }),
    }
}

/// Checks that `text` is a user certificate for the key in `key_pem`, and
/// says what is in it.
///
/// A host certificate, or one for another key, would be offered at every
/// connect and refused every time, with nothing to say why; better refused
/// once, here, with the reason.
pub fn check_for_key(text: &str, key_pem: &str, passphrase: Option<&str>) -> Result<CertInfo> {
    let cert = parse(text)?;
    if cert.cert_type() != CertType::User {
        bail!("This is a host certificate. Signing in needs a user certificate, made with ssh-keygen -s without -h.");
    }
    let key = public_key_of(key_pem, passphrase)?;
    if cert.public_key() != &key {
        bail!("This certificate is for a different key.");
    }
    Ok(inspect(&cert))
}

/// The public half of a private key.
///
/// The OpenSSH format keeps it outside the encryption, so an encrypted key
/// needs no passphrase for this; the older PEM formats do not, and are
/// decoded in full.
fn public_key_of(key_pem: &str, passphrase: Option<&str>) -> Result<KeyData> {
    if let Ok(key) = ssh_key::PrivateKey::from_openssh(key_pem) {
        return Ok(key.public_key().key_data().clone());
    }
    let pair = russh_keys::decode_secret_key(key_pem, passphrase).context("The key could not be read")?;
    let blob = russh_keys::PublicKeyBase64::public_key_bytes(&pair.clone_public_key()?);
    Ok(ssh_key::PublicKey::from_bytes(&blob)?.key_data().clone())
}

/// A certificate beside a key file, where `ssh-keygen -s` puts it and where
/// OpenSSH looks for it: `id_ed25519` has `id_ed25519-cert.pub`.
pub fn beside(key_path: &str) -> Option<String> {
    let path = format!("{key_path}-cert.pub");
    std::fs::read_to_string(Path::new(&path)).ok().filter(|t| parse(t).is_ok())
}

/// Whether the certificate is past its end, for the connect log to say
/// why it was refused.
pub fn expired(cert: &Certificate) -> bool {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    now >= cert.valid_before()
}

/// A security-key (`sk-`) private key. These need the key itself to sign,
/// through libfido2, which this app has no way to reach; said plainly when
/// one is added rather than failing later at connect.
pub fn is_security_key(pem: &str) -> bool {
    ssh_key::PrivateKey::from_openssh(pem)
        .is_ok_and(|k| matches!(k.algorithm(), Algorithm::SkEd25519 | Algorithm::SkEcdsaSha2NistP256))
}

pub const SECURITY_KEY_REFUSED: &str =
    "Security-key (sk-) keys are not supported; use an Ed25519, ECDSA or RSA key";

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::OsRng;
    use ssh_key::{certificate::Builder, LineEnding, PrivateKey};

    fn ed25519() -> PrivateKey {
        PrivateKey::random(&mut OsRng, Algorithm::Ed25519).unwrap()
    }

    fn certify(ca: &PrivateKey, key: &PrivateKey, cert_type: CertType, until: u64) -> String {
        let mut b = Builder::new([7u8; 16], key.public_key().key_data().clone(), 1_000, until).unwrap();
        b.cert_type(cert_type).unwrap();
        b.key_id("alice@laptop").unwrap();
        b.valid_principal("alice").unwrap();
        b.sign(ca).unwrap().to_openssh().unwrap()
    }

    #[test]
    fn a_user_certificate_for_the_key_is_accepted_and_described() {
        let (ca, key) = (ed25519(), ed25519());
        let pem = key.to_openssh(LineEnding::LF).unwrap();
        let info = check_for_key(&certify(&ca, &key, CertType::User, u64::MAX), &pem, None).unwrap();
        assert_eq!(info.key_id, "alice@laptop");
        assert_eq!(info.principals, ["alice"]);
        assert_eq!((info.valid_after, info.valid_before), (1_000, None));
        assert_eq!(info.ca_fingerprint, ca.public_key().fingerprint(HashAlg::Sha256).to_string());
        assert!(!info.rsa);
    }

    /// The public half sits outside the encryption, so no passphrase is needed.
    #[test]
    fn an_encrypted_key_is_matched_without_its_passphrase() {
        let (ca, key) = (ed25519(), ed25519());
        let pem = key.encrypt(&mut OsRng, "hunter2").unwrap().to_openssh(LineEnding::LF).unwrap();
        assert!(check_for_key(&certify(&ca, &key, CertType::User, u64::MAX), &pem, None).is_ok());
    }

    #[test]
    fn a_certificate_for_another_key_or_a_host_is_refused() {
        let (ca, key, other) = (ed25519(), ed25519(), ed25519());
        let pem = key.to_openssh(LineEnding::LF).unwrap();
        let e = check_for_key(&certify(&ca, &other, CertType::User, u64::MAX), &pem, None).unwrap_err();
        assert!(e.to_string().contains("different key"), "{e}");
        let e = check_for_key(&certify(&ca, &key, CertType::Host, u64::MAX), &pem, None).unwrap_err();
        assert!(e.to_string().contains("host certificate"), "{e}");
        assert!(check_for_key("ssh-ed25519 AAAA nope", &pem, None).is_err());
    }

    #[test]
    fn expiry_is_read_from_the_certificate() {
        let (ca, key) = (ed25519(), ed25519());
        assert!(expired(&parse(&certify(&ca, &key, CertType::User, 2_000)).unwrap()));
        assert!(!expired(&parse(&certify(&ca, &key, CertType::User, u64::MAX)).unwrap()));
    }

    #[test]
    fn a_certificate_is_found_beside_its_key() {
        let dir = std::env::temp_dir().join(format!("bifrossh-cert-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (ca, key) = (ed25519(), ed25519());
        let key_path = dir.join("id_ed25519").to_string_lossy().into_owned();
        assert_eq!(beside(&key_path), None);
        let cert = certify(&ca, &key, CertType::User, u64::MAX);
        std::fs::write(format!("{key_path}-cert.pub"), &cert).unwrap();
        assert_eq!(beside(&key_path).map(|t| t.trim().to_string()), Some(cert.trim().to_string()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_plain_key_is_not_a_security_key() {
        assert!(!is_security_key(&ed25519().to_openssh(LineEnding::LF).unwrap()));
        assert!(!is_security_key("not a key"));
    }

    /// What ssh-keygen -s writes when no -V is given: valid_before is all
    /// ones, "forever". The vendored ssh-key reads it; upstream 0.6.7 did not.
    #[test]
    fn a_certificate_valid_forever_reads() {
        let (ca, key) = (ed25519(), ed25519());
        let cert = parse(&certify(&ca, &key, CertType::User, u64::MAX)).unwrap();
        assert_eq!(cert.valid_before(), u64::MAX);
        assert!(!expired(&cert));
        assert_eq!(inspect(&cert).valid_before, None);
    }
}
