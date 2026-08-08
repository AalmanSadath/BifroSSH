//! Moving a BifroSSH setup between machines.
//!
//! `data.json` cannot simply be copied: it is sealed with a master key that
//! belongs to the machine it was made on, and the passwords and private keys
//! inside it are sealed a second time with that same key. An export therefore
//! re-keys every secret under a passphrase the user chooses, and an import
//! re-keys them again under the master key of the machine they land on.
//!
//! Import only ever adds. Anything already present wins, so running the same
//! file twice is a no-op and a stale export cannot undo newer local edits.

use std::collections::HashMap;

use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rand::RngCore;
use serde::{Deserialize, Serialize};

use crate::crypto;
use crate::keystore::{self, PassphraseForm, PassphraseWrapper};
use crate::models::{AppData, Codeprint, Identity, KeyEntry, PortForwarding, Server, Settings};

/// Marks the file as ours before anything is decrypted, so a wrong file gets a
/// clear answer instead of a passphrase prompt that can never succeed.
const FORMAT: &str = "bifrossh-export";
const VERSION: u32 = 1;

/// An export is a configuration file, not a disk image. Anything past this is
/// not one, and reading it would only be a way to spend memory.
const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;

// ── On-disk shape ───────────────────────────────────────────────────────────

/// The Argon2id parameters, carried in the file for the same reason the
/// keystore carries its own: raising them later must not make an old export
/// unopenable.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportKdf {
    pub salt: String,
    pub m_cost: u32,
    pub t_cost: u32,
    pub p_cost: u32,
    #[serde(default)]
    pub form: PassphraseForm,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportFile {
    pub format: String,
    pub version: u32,
    pub created: u64,
    pub app_version: String,
    pub kdf: ExportKdf,
    pub ciphertext: String,
}

/// What travels. The collections are the ordinary models, so serde needs no
/// help and nothing has to be kept in step with a second set of structs.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Payload {
    #[serde(default)]
    pub servers: Vec<Server>,
    #[serde(default)]
    pub identities: Vec<Identity>,
    #[serde(default)]
    pub keys: Vec<KeyEntry>,
    #[serde(default)]
    pub settings: Option<Settings>,
    #[serde(default)]
    pub port_forwardings: Vec<PortForwarding>,
    #[serde(default)]
    pub codeprints: Vec<Codeprint>,
    #[serde(default)]
    pub custom_themes: HashMap<String, serde_json::Value>,
    /// Raw OpenSSH known_hosts lines from BifroSSH's own file.
    #[serde(default)]
    pub known_hosts: Vec<String>,
}

// ── What the UI is told ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize)]
pub struct Counts {
    pub servers: usize,
    pub identities: usize,
    pub keys: usize,
    pub port_forwardings: usize,
    pub codeprints: usize,
    pub custom_themes: usize,
    pub known_hosts: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportResult {
    pub path: String,
    pub bytes: usize,
    pub counts: Counts,
    pub secrets_included: bool,
}

/// What an import would do, worked out without touching anything.
#[derive(Debug, Clone, Default, Serialize)]
pub struct MergePlan {
    pub created: u64,
    pub app_version: String,
    pub secrets_included: bool,
    /// Everything the file holds.
    pub incoming: Counts,
    /// How much of that is already here and would be skipped.
    pub duplicates: Counts,
    /// Names of key entries whose `key_path` does not exist on this machine.
    pub missing_key_paths: Vec<String>,
    /// Host specs the file disagrees with us about. Never overwritten.
    pub host_key_conflicts: Vec<String>,
    pub has_settings: bool,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ImportReport {
    pub added: Counts,
    pub skipped: Counts,
    /// References that pointed at something not imported and were cleared.
    pub unresolved_refs: usize,
    pub settings_replaced: bool,
    pub host_key_conflicts: Vec<String>,
}

/// Which parts of the file to take. Everything defaults off so a missing field
/// can never import more than the UI showed.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ImportOptions {
    #[serde(default)]
    pub servers: bool,
    #[serde(default)]
    pub identities: bool,
    #[serde(default)]
    pub keys: bool,
    #[serde(default)]
    pub port_forwardings: bool,
    #[serde(default)]
    pub codeprints: bool,
    #[serde(default)]
    pub custom_themes: bool,
    #[serde(default)]
    pub settings: bool,
    #[serde(default)]
    pub known_hosts: bool,
}

// ── Sealing ─────────────────────────────────────────────────────────────────

fn wrapper_for(kdf: &ExportKdf) -> PassphraseWrapper {
    PassphraseWrapper {
        salt: kdf.salt.clone(),
        m_cost: kdf.m_cost,
        t_cost: kdf.t_cost,
        p_cost: kdf.p_cost,
        blob: String::new(),
        form: kdf.form,
    }
}

fn derive(kdf: &ExportKdf, passphrase: &str) -> Result<[u8; 32]> {
    keystore::derive_passphrase_kek(passphrase, &wrapper_for(kdf))
}

/// Moves one secret field from one key to another.
///
/// A field that will not decrypt is dropped rather than failing the whole
/// export: it is already unusable, and losing an unreadable password is a
/// better outcome than being unable to move the other forty hosts.
fn rekey(field: &Option<String>, from: &[u8; 32], to: &[u8; 32]) -> Option<String> {
    let blob = field.as_ref()?;
    let plain = crypto::decrypt(blob, from).ok()?;
    crypto::encrypt(&plain, to).ok()
}

fn rekey_all(payload: &mut Payload, from: &[u8; 32], to: &[u8; 32]) {
    for s in &mut payload.servers {
        s.encrypted_password = rekey(&s.encrypted_password, from, to);
    }
    for i in &mut payload.identities {
        i.encrypted_password = rekey(&i.encrypted_password, from, to);
    }
    for k in &mut payload.keys {
        k.encrypted_key = rekey(&k.encrypted_key, from, to);
        k.encrypted_passphrase = rekey(&k.encrypted_passphrase, from, to);
    }
}

fn strip_secrets(payload: &mut Payload) {
    for s in &mut payload.servers {
        s.encrypted_password = None;
    }
    for i in &mut payload.identities {
        i.encrypted_password = None;
    }
    for k in &mut payload.keys {
        k.encrypted_key = None;
        k.encrypted_passphrase = None;
    }
}

fn has_secrets(payload: &Payload) -> bool {
    payload.servers.iter().any(|s| s.encrypted_password.is_some())
        || payload.identities.iter().any(|i| i.encrypted_password.is_some())
        || payload
            .keys
            .iter()
            .any(|k| k.encrypted_key.is_some() || k.encrypted_passphrase.is_some())
}

fn counts_of(payload: &Payload) -> Counts {
    Counts {
        servers: payload.servers.len(),
        identities: payload.identities.len(),
        keys: payload.keys.len(),
        port_forwardings: payload.port_forwardings.len(),
        codeprints: payload.codeprints.len(),
        custom_themes: payload.custom_themes.len(),
        known_hosts: payload.known_hosts.len(),
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Builds the finished file contents from a snapshot of the vault, with a
/// tally of what went in so the caller does not have to open it again to say.
pub fn build_export(
    data: &AppData,
    master: &[u8; 32],
    passphrase: &str,
    include_secrets: bool,
) -> Result<(String, Counts)> {
    if passphrase.is_empty() {
        return Err(anyhow!("An export needs a passphrase"));
    }

    let mut salt = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut salt);
    let kdf = ExportKdf {
        salt: BASE64.encode(salt),
        m_cost: 19 * 1024,
        t_cost: 2,
        p_cost: 1,
        form: keystore::detect_form(passphrase),
    };
    let export_key = derive(&kdf, passphrase)?;

    let mut payload = Payload {
        servers: data.servers.clone(),
        identities: data.identities.clone(),
        keys: data.keys.clone(),
        settings: Some(data.settings.clone()),
        port_forwardings: data.port_forwardings.clone(),
        codeprints: data.codeprints.clone(),
        custom_themes: data.custom_themes.clone(),
        known_hosts: crate::hostkeys::export_lines().unwrap_or_default(),
    };

    if include_secrets {
        rekey_all(&mut payload, master, &export_key);
    } else {
        strip_secrets(&mut payload);
    }

    let counts = counts_of(&payload);
    let file = ExportFile {
        format: FORMAT.to_string(),
        version: VERSION,
        created: now_secs(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        kdf,
        ciphertext: crypto::encrypt(&serde_json::to_vec(&payload)?, &export_key)?,
    };
    Ok((serde_json::to_string_pretty(&file)?, counts))
}

/// Opens a file, returning the payload with its secrets still sealed under the
/// export key, and that key so they can be moved across.
pub fn open_export(content: &str, passphrase: &str) -> Result<(ExportFile, Payload, [u8; 32])> {
    let file: ExportFile = serde_json::from_str(content)
        .map_err(|_| anyhow!("That is not a BifroSSH export file"))?;
    if file.format != FORMAT {
        return Err(anyhow!("That is not a BifroSSH export file"));
    }
    if file.version > VERSION {
        return Err(anyhow!(
            "That file was made by a newer version of BifroSSH (format {}). Update and try again.",
            file.version
        ));
    }

    let key = derive(&file.kdf, passphrase)?;
    // A wrong passphrase and a damaged file are the same AEAD failure. Saying
    // which it was would be a guess.
    let plain = crypto::decrypt(&file.ciphertext, &key)
        .map_err(|_| anyhow!("That passphrase does not open this file"))?;
    let payload: Payload = serde_json::from_slice(&plain)
        .map_err(|e| anyhow!("The file opened but its contents are unreadable: {e}"))?;
    Ok((file, payload, key))
}

/// Reads an export off disk, refusing anything implausibly large.
pub fn read_export_file(path: &str) -> Result<String> {
    let meta = std::fs::metadata(path).map_err(|e| anyhow!("{path}: {e}"))?;
    if meta.len() > MAX_FILE_BYTES {
        return Err(anyhow!(
            "{path} is {} MB, far larger than any export. Is that the right file?",
            meta.len() / (1024 * 1024)
        ));
    }
    std::fs::read_to_string(path).map_err(|e| anyhow!("{path}: {e}"))
}

// ── Merging ─────────────────────────────────────────────────────────────────

fn same_identity(a: &Identity, b: &Identity) -> bool {
    a.id == b.id || (a.name == b.name && a.username == b.username)
}

fn same_key(a: &KeyEntry, b: &KeyEntry) -> bool {
    if a.id == b.id {
        return true;
    }
    match (&a.key_path, &b.key_path) {
        (Some(x), Some(y)) => x == y,
        _ => a.name == b.name,
    }
}

fn same_server(a: &Server, b: &Server) -> bool {
    a.id == b.id || (a.host == b.host && a.port == b.port && a.username == b.username)
}

fn same_forwarding(a: &PortForwarding, b: &PortForwarding) -> bool {
    a.id == b.id
        || (a.label == b.label
            && a.kind == b.kind
            && a.local_port == b.local_port
            && a.dest_address == b.dest_address
            && a.dest_port == b.dest_port)
}

fn same_codeprint(a: &Codeprint, b: &Codeprint) -> bool {
    a.id == b.id || (a.name == b.name && a.command == b.command)
}

/// Works out what an import would do, changing nothing.
pub fn plan_merge(file: &ExportFile, payload: &Payload, current: &AppData) -> MergePlan {
    let dup = Counts {
        servers: payload
            .servers
            .iter()
            .filter(|s| current.servers.iter().any(|e| same_server(s, e)))
            .count(),
        identities: payload
            .identities
            .iter()
            .filter(|i| current.identities.iter().any(|e| same_identity(i, e)))
            .count(),
        keys: payload
            .keys
            .iter()
            .filter(|k| current.keys.iter().any(|e| same_key(k, e)))
            .count(),
        port_forwardings: payload
            .port_forwardings
            .iter()
            .filter(|p| current.port_forwardings.iter().any(|e| same_forwarding(p, e)))
            .count(),
        codeprints: payload
            .codeprints
            .iter()
            .filter(|c| current.codeprints.iter().any(|e| same_codeprint(c, e)))
            .count(),
        custom_themes: payload
            .custom_themes
            .keys()
            .filter(|k| current.custom_themes.contains_key(*k))
            .count(),
        known_hosts: 0,
    };

    let missing_key_paths = payload
        .keys
        .iter()
        .filter(|k| {
            k.key_path
                .as_ref()
                .is_some_and(|p| !std::path::Path::new(p).exists())
        })
        .map(|k| k.name.clone())
        .collect();

    MergePlan {
        created: file.created,
        app_version: file.app_version.clone(),
        secrets_included: has_secrets(payload),
        incoming: counts_of(payload),
        duplicates: dup,
        missing_key_paths,
        // Worked out by hostkeys at import time; listing them here would mean
        // parsing the file twice for a number the user acts on after the fact.
        host_key_conflicts: Vec::new(),
        has_settings: payload.settings.is_some(),
    }
}

/// Merges a payload into the vault. Never overwrites, never deletes.
pub fn apply_merge(
    mut payload: Payload,
    export_key: &[u8; 32],
    master: &[u8; 32],
    current: &mut AppData,
    opts: &ImportOptions,
) -> Result<ImportReport> {
    rekey_all(&mut payload, export_key, master);

    let mut report = ImportReport::default();

    // Pass one: add what is missing, and remember where every imported id
    // ended up so references can be pointed at it afterwards.
    let mut identity_ids: HashMap<String, String> = HashMap::new();
    if opts.identities {
        for incoming in payload.identities {
            match current.identities.iter().find(|e| same_identity(&incoming, e)) {
                Some(existing) => {
                    identity_ids.insert(incoming.id.clone(), existing.id.clone());
                    report.skipped.identities += 1;
                }
                None => {
                    identity_ids.insert(incoming.id.clone(), incoming.id.clone());
                    current.identities.push(incoming);
                    report.added.identities += 1;
                }
            }
        }
    }

    let mut key_ids: HashMap<String, String> = HashMap::new();
    if opts.keys {
        for incoming in payload.keys {
            match current.keys.iter().find(|e| same_key(&incoming, e)) {
                Some(existing) => {
                    key_ids.insert(incoming.id.clone(), existing.id.clone());
                    report.skipped.keys += 1;
                }
                None => {
                    key_ids.insert(incoming.id.clone(), incoming.id.clone());
                    current.keys.push(incoming);
                    report.added.keys += 1;
                }
            }
        }
    }

    let mut server_ids: HashMap<String, String> = HashMap::new();
    let mut added_servers: Vec<String> = Vec::new();
    if opts.servers {
        for incoming in payload.servers {
            match current.servers.iter().find(|e| same_server(&incoming, e)) {
                Some(existing) => {
                    server_ids.insert(incoming.id.clone(), existing.id.clone());
                    report.skipped.servers += 1;
                }
                None => {
                    server_ids.insert(incoming.id.clone(), incoming.id.clone());
                    added_servers.push(incoming.id.clone());
                    current.servers.push(incoming);
                    report.added.servers += 1;
                }
            }
        }
    }

    let mut added_forwardings: Vec<String> = Vec::new();
    if opts.port_forwardings {
        for incoming in payload.port_forwardings {
            match current
                .port_forwardings
                .iter()
                .find(|e| same_forwarding(&incoming, e))
            {
                Some(_) => report.skipped.port_forwardings += 1,
                None => {
                    added_forwardings.push(incoming.id.clone());
                    current.port_forwardings.push(incoming);
                    report.added.port_forwardings += 1;
                }
            }
        }
    }

    if opts.codeprints {
        for incoming in payload.codeprints {
            match current.codeprints.iter().find(|e| same_codeprint(&incoming, e)) {
                Some(_) => report.skipped.codeprints += 1,
                None => {
                    current.codeprints.push(incoming);
                    report.added.codeprints += 1;
                }
            }
        }
    }

    if opts.custom_themes {
        for (name, theme) in payload.custom_themes {
            if current.custom_themes.contains_key(&name) {
                report.skipped.custom_themes += 1;
            } else {
                current.custom_themes.insert(name, theme);
                report.added.custom_themes += 1;
            }
        }
    }

    // Pass two: rewrite references on the records we just added. A reference
    // that resolves to nothing is cleared rather than left pointing at
    // whatever happens to hold that id here.
    let mut unresolved = 0usize;
    let resolve = |id: &Option<String>, map: &HashMap<String, String>, missed: &mut usize| {
        match id {
            None => None,
            Some(old) => match map.get(old) {
                Some(new) => Some(new.clone()),
                None => {
                    *missed += 1;
                    None
                }
            },
        }
    };

    for server in current
        .servers
        .iter_mut()
        .filter(|s| added_servers.contains(&s.id))
    {
        server.identity_id = resolve(&server.identity_id, &identity_ids, &mut unresolved);
        server.key_id = resolve(&server.key_id, &key_ids, &mut unresolved);
        server.proxy_jump = resolve(&server.proxy_jump, &server_ids, &mut unresolved);
        if server.proxy_jump.as_deref() == Some(server.id.as_str()) {
            server.proxy_jump = None;
        }
    }

    for pf in current
        .port_forwardings
        .iter_mut()
        .filter(|p| added_forwardings.contains(&p.id))
    {
        pf.intermediate_host_id = resolve(&pf.intermediate_host_id, &server_ids, &mut unresolved);
        pf.remote_host_id = resolve(&pf.remote_host_id, &server_ids, &mut unresolved);
    }

    report.unresolved_refs = unresolved;

    if opts.settings {
        if let Some(settings) = payload.settings {
            current.settings = settings;
            report.settings_replaced = true;
        }
    }

    if opts.known_hosts && !payload.known_hosts.is_empty() {
        match crate::hostkeys::import_lines(&payload.known_hosts) {
            Ok(hosts) => {
                report.added.known_hosts = hosts.added;
                report.skipped.known_hosts = hosts.skipped;
                report.host_key_conflicts = hosts.conflicts;
            }
            // known_hosts lives in its own file. Failing to write it must not
            // throw away a merge that has already been made in memory.
            Err(e) => report
                .host_key_conflicts
                .push(format!("known_hosts could not be written: {e}")),
        }
    }

    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(byte: u8) -> [u8; 32] {
        [byte; 32]
    }

    fn server(id: &str, host: &str, password: Option<&str>, master: &[u8; 32]) -> Server {
        Server {
            id: id.to_string(),
            name: format!("host {id}"),
            host: host.to_string(),
            port: 22,
            identity_id: None,
            username: Some("root".to_string()),
            encrypted_password: password.map(|p| crypto::encrypt(p.as_bytes(), master).unwrap()),
            key_id: None,
            theme: None,
            os: String::new(),
            connection_timeout: None,
            auth_kind: None,
            proxy_jump: None,
        }
    }

    fn identity(id: &str, name: &str) -> Identity {
        Identity {
            id: id.to_string(),
            name: name.to_string(),
            username: "deploy".to_string(),
            key_id: None,
            encrypted_password: None,
            auth_kind: None,
            agent_fingerprint: None,
        }
    }

    fn all_options() -> ImportOptions {
        ImportOptions {
            servers: true,
            identities: true,
            keys: true,
            port_forwardings: true,
            codeprints: true,
            custom_themes: true,
            settings: true,
            // Writes to the real data dir, so it stays off unless a test wants it.
            known_hosts: false,
        }
    }

    /// An export built without touching the filesystem, so the tests never
    /// read or write the running user's known_hosts.
    fn seal(payload: &Payload, passphrase: &str) -> String {
        let mut salt = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut salt);
        let kdf = ExportKdf {
            salt: BASE64.encode(salt),
            // Deliberately weak: these run on every `cargo test`.
            m_cost: 8,
            t_cost: 1,
            p_cost: 1,
            form: keystore::detect_form(passphrase),
        };
        let export_key = derive(&kdf, passphrase).unwrap();
        let mut sealed = payload.clone();
        rekey_all(&mut sealed, &key(1), &export_key);
        let file = ExportFile {
            format: FORMAT.to_string(),
            version: VERSION,
            created: 1,
            app_version: "test".to_string(),
            kdf,
            ciphertext: crypto::encrypt(&serde_json::to_vec(&sealed).unwrap(), &export_key).unwrap(),
        };
        serde_json::to_string(&file).unwrap()
    }

    #[test]
    fn round_trip_moves_secrets_to_the_target_key() {
        let source = key(1);
        let target = key(2);
        let payload = Payload {
            servers: vec![server("s1", "alpha.example", Some("hunter2"), &source)],
            identities: vec![identity("i1", "deploy")],
            ..Default::default()
        };

        let content = seal(&payload, "correct horse battery");
        let (_, opened, export_key) = open_export(&content, "correct horse battery").unwrap();

        let mut current = AppData::default();
        let report = apply_merge(opened, &export_key, &target, &mut current, &all_options()).unwrap();

        assert_eq!(report.added.servers, 1);
        assert_eq!(report.added.identities, 1);
        let stored = current.servers[0].encrypted_password.as_ref().unwrap();
        assert_eq!(crypto::decrypt(stored, &target).unwrap(), b"hunter2");
        // The old key must not still open it.
        assert!(crypto::decrypt(stored, &source).is_err());
    }

    #[test]
    fn wrong_passphrase_is_reported_plainly() {
        let content = seal(&Payload::default(), "right one");
        let err = open_export(&content, "wrong one").unwrap_err().to_string();
        assert_eq!(err, "That passphrase does not open this file");
    }

    #[test]
    fn stripping_secrets_leaves_the_rest_importable() {
        let source = key(1);
        let mut payload = Payload {
            servers: vec![server("s1", "alpha.example", Some("hunter2"), &source)],
            keys: vec![KeyEntry {
                id: "k1".to_string(),
                name: "id_ed25519".to_string(),
                key_path: None,
                encrypted_key: Some(crypto::encrypt(b"PRIVATE", &source).unwrap()),
                encrypted_passphrase: Some(crypto::encrypt(b"pw", &source).unwrap()),
                algorithm: None,
            }],
            ..Default::default()
        };
        strip_secrets(&mut payload);
        assert!(!has_secrets(&payload));

        let content = seal(&payload, "no secrets here");
        let (_, opened, export_key) = open_export(&content, "no secrets here").unwrap();
        let mut current = AppData::default();
        apply_merge(opened, &export_key, &key(2), &mut current, &all_options()).unwrap();

        assert_eq!(current.servers.len(), 1);
        assert!(current.servers[0].encrypted_password.is_none());
        assert!(current.keys[0].encrypted_key.is_none());
        assert!(current.keys[0].encrypted_passphrase.is_none());
    }

    #[test]
    fn duplicate_by_id_leaves_the_local_record_alone() {
        let payload = Payload {
            servers: vec![server("s1", "changed.example", None, &key(1))],
            ..Default::default()
        };
        let mut current = AppData::default();
        current.servers.push(server("s1", "original.example", None, &key(2)));

        let content = seal(&payload, "phrase");
        let (_, opened, ek) = open_export(&content, "phrase").unwrap();
        let report = apply_merge(opened, &ek, &key(2), &mut current, &all_options()).unwrap();

        assert_eq!(report.skipped.servers, 1);
        assert_eq!(report.added.servers, 0);
        assert_eq!(current.servers.len(), 1);
        assert_eq!(current.servers[0].host, "original.example");
    }

    #[test]
    fn duplicate_by_host_port_user_skips_despite_a_new_id() {
        let payload = Payload {
            servers: vec![server("other-id", "alpha.example", None, &key(1))],
            ..Default::default()
        };
        let mut current = AppData::default();
        current.servers.push(server("s1", "alpha.example", None, &key(2)));

        let content = seal(&payload, "phrase");
        let (_, opened, ek) = open_export(&content, "phrase").unwrap();
        let report = apply_merge(opened, &ek, &key(2), &mut current, &all_options()).unwrap();

        assert_eq!(report.skipped.servers, 1);
        assert_eq!(current.servers.len(), 1);
        assert_eq!(current.servers[0].id, "s1");
    }

    #[test]
    fn references_are_remapped_onto_the_local_record() {
        let mut incoming = server("s-new", "beta.example", None, &key(1));
        incoming.identity_id = Some("i-remote".to_string());
        let payload = Payload {
            servers: vec![incoming],
            identities: vec![identity("i-remote", "deploy")],
            ..Default::default()
        };

        let mut current = AppData::default();
        // Same name and username, different id: the local one must win.
        current.identities.push(identity("i-local", "deploy"));

        let content = seal(&payload, "phrase");
        let (_, opened, ek) = open_export(&content, "phrase").unwrap();
        let report = apply_merge(opened, &ek, &key(2), &mut current, &all_options()).unwrap();

        assert_eq!(report.skipped.identities, 1);
        assert_eq!(current.identities.len(), 1);
        assert_eq!(current.servers[0].identity_id.as_deref(), Some("i-local"));
        assert_eq!(report.unresolved_refs, 0);
    }

    #[test]
    fn a_reference_to_something_not_imported_is_cleared() {
        let mut incoming = server("s-new", "beta.example", None, &key(1));
        incoming.identity_id = Some("i-remote".to_string());
        let payload = Payload {
            servers: vec![incoming],
            identities: vec![identity("i-remote", "deploy")],
            ..Default::default()
        };

        let mut opts = all_options();
        opts.identities = false;

        let content = seal(&payload, "phrase");
        let (_, opened, ek) = open_export(&content, "phrase").unwrap();
        let mut current = AppData::default();
        let report = apply_merge(opened, &ek, &key(2), &mut current, &opts).unwrap();

        assert!(current.identities.is_empty());
        assert!(current.servers[0].identity_id.is_none());
        assert_eq!(report.unresolved_refs, 1);
    }

    #[test]
    fn proxy_jump_resolves_to_a_server_imported_in_the_same_run() {
        let mut a = server("s-a", "bastion.example", None, &key(1));
        a.name = "bastion".to_string();
        let mut b = server("s-b", "inner.example", None, &key(1));
        b.proxy_jump = Some("s-a".to_string());

        let payload = Payload { servers: vec![b, a], ..Default::default() };
        let content = seal(&payload, "phrase");
        let (_, opened, ek) = open_export(&content, "phrase").unwrap();
        let mut current = AppData::default();
        let report = apply_merge(opened, &ek, &key(2), &mut current, &all_options()).unwrap();

        let inner = current.servers.iter().find(|s| s.host == "inner.example").unwrap();
        assert_eq!(inner.proxy_jump.as_deref(), Some("s-a"));
        assert_eq!(report.unresolved_refs, 0);
    }

    #[test]
    fn an_unticked_category_is_left_untouched() {
        let payload = Payload {
            servers: vec![server("s1", "alpha.example", None, &key(1))],
            codeprints: vec![Codeprint {
                id: "c1".to_string(),
                name: "uptime".to_string(),
                command: "uptime".to_string(),
            }],
            ..Default::default()
        };
        let mut opts = all_options();
        opts.servers = false;

        let content = seal(&payload, "phrase");
        let (_, opened, ek) = open_export(&content, "phrase").unwrap();
        let mut current = AppData::default();
        apply_merge(opened, &ek, &key(2), &mut current, &opts).unwrap();

        assert!(current.servers.is_empty());
        assert_eq!(current.codeprints.len(), 1);
    }

    #[test]
    fn settings_are_only_replaced_when_asked_for() {
        let mut settings = Settings::default();
        settings.font_size = 22;
        let payload = Payload { settings: Some(settings), ..Default::default() };
        let content = seal(&payload, "phrase");

        let mut opts = all_options();
        opts.settings = false;
        let (_, opened, ek) = open_export(&content, "phrase").unwrap();
        let mut current = AppData::default();
        let report = apply_merge(opened, &ek, &key(2), &mut current, &opts).unwrap();
        assert_eq!(current.settings.font_size, 14);
        assert!(!report.settings_replaced);

        let (_, opened, ek) = open_export(&content, "phrase").unwrap();
        let mut current = AppData::default();
        let report = apply_merge(opened, &ek, &key(2), &mut current, &all_options()).unwrap();
        assert_eq!(current.settings.font_size, 22);
        assert!(report.settings_replaced);
    }

    #[test]
    fn a_file_we_did_not_write_is_named_as_such() {
        let err = open_export("{\"hello\":true}", "phrase").unwrap_err().to_string();
        assert_eq!(err, "That is not a BifroSSH export file");

        let err = open_export("not json at all", "phrase").unwrap_err().to_string();
        assert_eq!(err, "That is not a BifroSSH export file");
    }

    #[test]
    fn a_newer_format_says_so_rather_than_failing_to_parse() {
        let content = seal(&Payload::default(), "phrase");
        let mut file: serde_json::Value = serde_json::from_str(&content).unwrap();
        file["version"] = serde_json::json!(99);
        let bumped = serde_json::to_string(&file).unwrap();

        let err = open_export(&bumped, "phrase").unwrap_err().to_string();
        assert!(err.contains("newer version"), "{err}");
    }

    #[test]
    fn the_plan_counts_what_is_already_here() {
        let payload = Payload {
            servers: vec![
                server("s1", "alpha.example", None, &key(1)),
                server("s2", "beta.example", None, &key(1)),
            ],
            settings: Some(Settings::default()),
            ..Default::default()
        };
        let content = seal(&payload, "phrase");
        let (file, opened, _) = open_export(&content, "phrase").unwrap();

        let mut current = AppData::default();
        current.servers.push(server("s1", "alpha.example", None, &key(2)));

        let plan = plan_merge(&file, &opened, &current);
        assert_eq!(plan.incoming.servers, 2);
        assert_eq!(plan.duplicates.servers, 1);
        assert!(plan.has_settings);
    }

    /// The write/read half, against a real file.
    ///
    /// `build_export` is deliberately not used here: it reads the running
    /// user's known_hosts, which has no business in a test fixture.
    #[test]
    fn an_export_on_disk_is_private_and_reads_back() {
        let dir = std::env::temp_dir().join(format!("bifrossh-export-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("export.bfx");

        let payload = Payload {
            servers: vec![server("s1", "alpha.example", Some("hunter2"), &key(1))],
            ..Default::default()
        };
        let content = seal(&payload, "phrase");
        crate::store::write_private(&path, content.as_bytes()).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o077, 0, "an export holds secrets and must be 0600");
        }

        let read_back = read_export_file(path.to_str().unwrap()).unwrap();
        let (_, opened, _) = open_export(&read_back, "phrase").unwrap();
        assert_eq!(opened.servers.len(), 1);

        assert!(
            read_export_file(dir.join("nothing-here.bfx").to_str().unwrap()).is_err(),
            "a missing file must be an error, not an empty import"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_plan_flags_key_paths_this_machine_does_not_have() {
        let payload = Payload {
            keys: vec![KeyEntry {
                id: "k1".to_string(),
                name: "work key".to_string(),
                key_path: Some("/definitely/not/here/id_ed25519".to_string()),
                encrypted_key: None,
                encrypted_passphrase: None,
                algorithm: None,
            }],
            ..Default::default()
        };
        let content = seal(&payload, "phrase");
        let (file, opened, _) = open_export(&content, "phrase").unwrap();
        let plan = plan_merge(&file, &opened, &AppData::default());
        assert_eq!(plan.missing_key_paths, vec!["work key".to_string()]);
    }
}
