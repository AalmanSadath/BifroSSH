use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex};

use anyhow::Result;
use async_trait::async_trait;
use base64::engine::general_purpose::{STANDARD as B64, STANDARD_NO_PAD as B64_NOPAD};
use base64::Engine as _;
use hmac::{Hmac, Mac};
use russh::client;
use russh_keys::key::PublicKey;
use russh_keys::PublicKeyBase64;
use sha1::Sha1;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter};
use tokio::sync::oneshot;
use tokio::time::{timeout, Duration};

use crate::prompts::{HostKeyDecision, HostKeyPromptEvent, PromptCancelEvent, PromptState};
use crate::store::get_data_dir;

/// Serialises rewrites so two connects learning at once cannot interleave.
static WRITE_LOCK: StdMutex<()> = StdMutex::new(());

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKeySource {
    Bifrossh,
    OpenSsh,
}

impl HostKeySource {
    pub fn as_str(self) -> &'static str {
        match self {
            HostKeySource::Bifrossh => "bifrossh",
            HostKeySource::OpenSsh => "openssh",
        }
    }
}

#[derive(Debug)]
pub enum KnownHostStatus {
    Match {
        source: HostKeySource,
    },
    Unknown,
    Mismatch {
        source: HostKeySource,
        line: usize,
        existing_type: String,
        existing_fp: String,
    },
    Revoked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostKeyPolicy {
    Ask,
    AcceptNew,
    Strict,
}

impl HostKeyPolicy {
    pub fn from_str(s: &str) -> Self {
        match s {
            "accept-new" => HostKeyPolicy::AcceptNew,
            "strict" => HostKeyPolicy::Strict,
            _ => HostKeyPolicy::Ask,
        }
    }
}

#[derive(serde::Serialize, Clone)]
pub struct KnownHostEntry {
    pub host: String,
    pub port: u16,
    pub key_type: String,
    pub fingerprint: String,
    pub source: String,
    pub line: usize,
}

pub fn bifrossh_known_hosts_path() -> Result<PathBuf> {
    Ok(get_data_dir()?.join("known_hosts"))
}

pub fn openssh_known_hosts_path() -> Option<PathBuf> {
    let path = dirs::home_dir()?.join(".ssh").join("known_hosts");
    path.exists().then_some(path)
}

/// The algorithm name embedded in the key blob itself.
///
/// This is the authoritative name, and deliberately not `PublicKey::name()`:
/// for RSA that method reports the *negotiated signature* algorithm
/// (`rsa-sha2-512`, ...) while `public_key_bytes()` always embeds `ssh-rsa`.
/// Writing the former next to the latter produces a known_hosts line OpenSSH
/// rejects, and comparing on it reports a false mismatch for the same key.
fn algo_from_blob(blob: &[u8]) -> Option<String> {
    if blob.len() < 4 {
        return None;
    }
    let n = u32::from_be_bytes([blob[0], blob[1], blob[2], blob[3]]) as usize;
    if n > 64 || blob.len() < 4 + n {
        return None;
    }
    String::from_utf8(blob[4..4 + n].to_vec()).ok()
}

fn fingerprint_from_blob(blob: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(blob);
    format!("SHA256:{}", B64_NOPAD.encode(hasher.finalize()))
}

pub fn fingerprint(key: &PublicKey) -> String {
    fingerprint_from_blob(&key.public_key_bytes())
}

pub fn key_type(key: &PublicKey) -> String {
    algo_from_blob(&key.public_key_bytes()).unwrap_or_else(|| key.name().to_string())
}

/// The form OpenSSH matches and hashes against: bare host on 22, `[host]:port` otherwise.
fn host_spec(host: &str, port: u16) -> String {
    if port == 22 {
        host.to_string()
    } else {
        format!("[{}]:{}", host, port)
    }
}

struct RawLine {
    line_no: usize,
    marker: Option<String>,
    hosts: String,
    b64: String,
}

fn scan(path: &Path) -> Vec<RawLine> {
    let Ok(content) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (i, raw) in content.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut fields = line.split_whitespace();
        let Some(mut first) = fields.next() else { continue };
        let mut marker = None;
        if first.starts_with('@') {
            marker = Some(first.to_string());
            let Some(next) = fields.next() else { continue };
            first = next;
        }
        // field order is: hosts, algorithm, base64 — the algorithm is redundant
        // with the blob and is not trusted.
        let Some(_algo) = fields.next() else { continue };
        let Some(b64) = fields.next() else { continue };
        out.push(RawLine {
            line_no: i + 1,
            marker,
            hosts: first.to_string(),
            b64: b64.to_string(),
        });
    }
    out
}

fn glob_match(pattern: &str, text: &str) -> bool {
    let p: Vec<char> = pattern.chars().collect();
    let t: Vec<char> = text.chars().collect();
    // iterative wildcard match with backtracking on '*'
    let (mut pi, mut ti) = (0usize, 0usize);
    let (mut star, mut back) = (usize::MAX, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = pi;
            back = ti;
            pi += 1;
        } else if star != usize::MAX {
            pi = star + 1;
            back += 1;
            ti = back;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

fn host_matches(field: &str, target: &str) -> bool {
    if let Some(rest) = field.strip_prefix("|1|") {
        let mut parts = rest.splitn(2, '|');
        let (Some(salt_b64), Some(hash_b64)) = (parts.next(), parts.next()) else {
            return false;
        };
        let (Ok(salt), Ok(hash)) = (B64.decode(salt_b64), B64.decode(hash_b64)) else {
            return false;
        };
        let Ok(mut mac) = Hmac::<Sha1>::new_from_slice(&salt) else {
            return false;
        };
        mac.update(target.as_bytes());
        return mac.verify_slice(&hash).is_ok();
    }

    let mut matched = false;
    for pat in field.split(',') {
        if let Some(negated) = pat.strip_prefix('!') {
            if glob_match(negated, target) {
                return false;
            }
        } else if glob_match(pat, target) {
            matched = true;
        }
    }
    matched
}

pub fn check_host(host: &str, port: u16, key: &PublicKey) -> KnownHostStatus {
    let blob = key.public_key_bytes();
    let algo = algo_from_blob(&blob).unwrap_or_default();
    let target = host_spec(host, port);

    let sources = [
        (HostKeySource::Bifrossh, bifrossh_known_hosts_path().ok()),
        (HostKeySource::OpenSsh, openssh_known_hosts_path()),
    ];

    // A match anywhere outranks a mismatch seen earlier: a host mid key-rotation
    // can legitimately have a stale line above the current one.
    let mut mismatch: Option<KnownHostStatus> = None;

    for (source, path) in sources {
        let Some(path) = path else { continue };
        for line in scan(&path) {
            if !host_matches(&line.hosts, &target) {
                continue;
            }
            // Unparseable or unsupported (sk-*, ssh-dss) entries are skipped, never
            // fatal — one bad line must not make the host permanently unverifiable.
            let Ok(line_blob) = B64.decode(line.b64.as_bytes()) else {
                continue;
            };
            let Some(line_algo) = algo_from_blob(&line_blob) else {
                continue;
            };
            if line_algo != algo {
                continue;
            }

            if line_blob == blob {
                match line.marker.as_deref() {
                    Some("@revoked") => return KnownHostStatus::Revoked,
                    // A CA line delegates trust to a signed certificate, which is a
                    // different verification path than we implement. Not a host key.
                    Some("@cert-authority") => continue,
                    _ => {}
                }
                if source == HostKeySource::OpenSsh {
                    let _ = learn_host(host, port, key);
                }
                return KnownHostStatus::Match { source };
            }

            if line.marker.is_none() && mismatch.is_none() {
                mismatch = Some(KnownHostStatus::Mismatch {
                    source,
                    line: line.line_no,
                    existing_type: line_algo,
                    existing_fp: fingerprint_from_blob(&line_blob),
                });
            }
        }
    }

    mismatch.unwrap_or(KnownHostStatus::Unknown)
}

fn format_line(host: &str, port: u16, key: &PublicKey) -> Option<String> {
    let blob = key.public_key_bytes();
    let algo = algo_from_blob(&blob)?;
    Some(format!(
        "{} {} {}",
        host_spec(host, port),
        algo,
        B64.encode(&blob)
    ))
}

pub fn learn_host(host: &str, port: u16, key: &PublicKey) -> Result<()> {
    let Some(line) = format_line(host, port, key) else {
        return Err(anyhow::anyhow!("Unsupported host key format"));
    };
    let path = bifrossh_known_hosts_path()?;
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    // Don't duplicate a line we already hold.
    if scan(&path).iter().any(|l| {
        l.marker.is_none()
            && host_matches(&l.hosts, &host_spec(host, port))
            && l.b64 == B64.encode(key.public_key_bytes())
    }) {
        return Ok(());
    }

    let needs_newline = fs::read(&path)
        .ok()
        .and_then(|b| b.last().copied())
        .is_some_and(|b| b != b'\n');

    let mut file = OpenOptions::new().append(true).create(true).open(&path)?;
    if needs_newline {
        file.write_all(b"\n")?;
    }
    writeln!(file, "{}", line)?;
    drop(file);
    set_owner_only(&path)?;
    Ok(())
}

/// Drop every non-marker line for this host/algorithm, then record `key`.
pub fn replace_host(host: &str, port: u16, key: &PublicKey) -> Result<()> {
    let algo = algo_from_blob(&key.public_key_bytes());
    remove_lines(host, port, algo.as_deref())?;
    learn_host(host, port, key)
}

pub fn forget_host(host: &str, port: u16) -> Result<usize> {
    remove_lines(host, port, None)
}

/// Rewrites BifroSSH's file only — `~/.ssh/known_hosts` is never modified.
fn remove_lines(host: &str, port: u16, algo: Option<&str>) -> Result<usize> {
    let path = bifrossh_known_hosts_path()?;
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let Ok(content) = fs::read_to_string(&path) else {
        return Ok(0);
    };
    let target = host_spec(host, port);
    let mut kept = Vec::new();
    let mut removed = 0usize;

    for raw in content.lines() {
        let line = raw.trim();
        let drop_it = (|| {
            if line.is_empty() || line.starts_with('#') || line.starts_with('@') {
                return false;
            }
            let mut fields = line.split_whitespace();
            let (Some(hosts), Some(_), Some(b64)) =
                (fields.next(), fields.next(), fields.next())
            else {
                return false;
            };
            if !host_matches(hosts, &target) {
                return false;
            }
            match algo {
                None => true,
                Some(want) => B64
                    .decode(b64.as_bytes())
                    .ok()
                    .and_then(|b| algo_from_blob(&b))
                    .is_some_and(|a| a == want),
            }
        })();

        if drop_it {
            removed += 1;
        } else {
            kept.push(raw);
        }
    }

    if removed == 0 {
        return Ok(0);
    }

    let tmp = path.with_extension("tmp");
    let mut body = kept.join("\n");
    if !body.is_empty() {
        body.push('\n');
    }
    fs::write(&tmp, body)?;
    set_owner_only(&tmp)?;
    fs::rename(&tmp, &path)?;
    Ok(removed)
}

pub fn list_known_hosts() -> Result<Vec<KnownHostEntry>> {
    let mut out: Vec<KnownHostEntry> = Vec::new();
    // Bifrossh first, so that when the same key exists in both files the entry
    // we keep is the one the user can actually act on.
    let sources = [
        (HostKeySource::Bifrossh, bifrossh_known_hosts_path().ok()),
        (HostKeySource::OpenSsh, openssh_known_hosts_path()),
    ];

    for (source, path) in sources {
        let Some(path) = path else { continue };
        for line in scan(&path) {
            let Ok(blob) = B64.decode(line.b64.as_bytes()) else {
                continue;
            };
            let Some(algo) = algo_from_blob(&blob) else {
                continue;
            };
            let (host, port) = split_host_spec(&line.hosts);
            let fingerprint = fingerprint_from_blob(&blob);

            // Trusting a host recorded in ~/.ssh mirrors it into our own file,
            // so the same key legitimately appears twice. Listing it twice
            // would just look like a duplicate to the user.
            if out.iter().any(|e| {
                e.host == host && e.port == port && e.fingerprint == fingerprint
            }) {
                continue;
            }

            out.push(KnownHostEntry {
                host,
                port,
                key_type: algo,
                fingerprint,
                source: source.as_str().to_string(),
                line: line.line_no,
            });
        }
    }
    Ok(out)
}

/// What an import did, so the user can be told rather than guess.
#[derive(Debug, Default, serde::Serialize, Clone)]
pub struct ImportedHosts {
    pub added: usize,
    /// Already held, byte for byte.
    pub skipped: usize,
    /// Host specs we already hold a *different* key for. Left alone.
    pub conflicts: Vec<String>,
}

/// BifroSSH's own known_hosts, as raw lines, for putting in an export.
///
/// `~/.ssh/known_hosts` is deliberately not included: it is not ours to carry
/// to another machine, and anything from it that BifroSSH has actually used
/// has already been mirrored into our own file by `check_host`.
pub fn export_lines() -> Result<Vec<String>> {
    let path = bifrossh_known_hosts_path()?;
    let Ok(content) = fs::read_to_string(&path) else {
        return Ok(Vec::new());
    };
    Ok(content
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(str::to_string)
        .collect())
}

/// Splits a known_hosts line into (marker, hosts, algorithm, base64).
///
/// The algorithm is taken from the blob rather than the line's own third
/// field, for the reason `algo_from_blob` documents.
fn parse_line(line: &str) -> Option<(Option<String>, String, String, String)> {
    let mut fields = line.split_whitespace();
    let mut first = fields.next()?;
    let mut marker = None;
    if first.starts_with('@') {
        marker = Some(first.to_string());
        first = fields.next()?;
    }
    let _stated_algo = fields.next()?;
    let b64 = fields.next()?;
    let blob = B64.decode(b64.as_bytes()).ok()?;
    let algo = algo_from_blob(&blob)?;
    Some((marker, first.to_string(), algo, b64.to_string()))
}

/// Decides what an import would append, given the file as it stands.
///
/// Split out from the writing so the rule can be tested without a real
/// known_hosts underneath it.
fn merge_lines(existing: &str, incoming: &[String]) -> (ImportedHosts, Vec<String>) {
    // Grows as lines are accepted, so a file listing the same host twice is
    // judged against what the earlier line already put in.
    let mut held: Vec<(Option<String>, String, String, String)> = existing
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .filter_map(parse_line)
        .collect();

    let mut report = ImportedHosts::default();
    let mut pending: Vec<String> = Vec::new();

    for raw in incoming {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let Some(entry) = parse_line(line) else {
            report.skipped += 1;
            continue;
        };
        let (marker, hosts, algo, b64) = entry;

        match held
            .iter()
            .find(|e| e.0 == marker && e.1 == hosts && e.2 == algo)
        {
            Some(e) if e.3 == b64 => report.skipped += 1,
            Some(_) => report.conflicts.push(hosts),
            None => {
                held.push((marker, hosts, algo, b64));
                pending.push(line.to_string());
                report.added += 1;
            }
        }
    }

    (report, pending)
}

/// Merges known_hosts lines from an export into BifroSSH's file.
///
/// A host we already hold a different key for is reported, never replaced.
/// Trusting a new identity for a known host is exactly the decision the
/// mismatch prompt exists to put in front of the user, and a file import is
/// not that prompt.
pub fn import_lines(lines: &[String]) -> Result<ImportedHosts> {
    let path = bifrossh_known_hosts_path()?;
    let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());

    let (report, pending) = merge_lines(&fs::read_to_string(&path).unwrap_or_default(), lines);

    if pending.is_empty() {
        return Ok(report);
    }

    let needs_newline = fs::read(&path)
        .ok()
        .and_then(|b| b.last().copied())
        .is_some_and(|b| b != b'\n');

    let mut file = OpenOptions::new().append(true).create(true).open(&path)?;
    if needs_newline {
        file.write_all(b"\n")?;
    }
    for line in &pending {
        writeln!(file, "{}", line)?;
    }
    drop(file);
    set_owner_only(&path)?;
    Ok(report)
}

/// `[host]:port` back to its parts. Hashed entries stay opaque.
fn split_host_spec(spec: &str) -> (String, u16) {
    if let Some(rest) = spec.strip_prefix('[') {
        if let Some((host, port)) = rest.rsplit_once("]:") {
            if let Ok(port) = port.parse::<u16>() {
                return (host.to_string(), port);
            }
        }
    }
    (spec.to_string(), 22)
}

fn set_owner_only(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

// ---------------------------------------------------------------------------
// Verification during a connect
// ---------------------------------------------------------------------------

/// Everything a connect needs in order to decide about a host key.
#[derive(Clone)]
pub struct ConnectSecurity {
    pub app: AppHandle,
    pub prompts: Arc<PromptState>,
    pub policy: HostKeyPolicy,
    /// `Some` also narrates into the ConnectingView log for that connect.
    pub connect_id: Option<String>,
    /// Background connects (OS detection) cannot prompt and must fail closed.
    pub interactive: bool,
    /// Raised while a modal is up. The command that owns the connect timeout
    /// watches this so a user reading a fingerprint isn't timed out.
    pub waiting: Arc<AtomicBool>,
}

impl ConnectSecurity {
    /// Narrates a step into the connection log. A connect with no `connect_id`
    /// (background OS detection) has nowhere to show it, so this is a no-op.
    pub fn log(&self, kind: &str, message: &str) {
        if let Some(connect_id) = &self.connect_id {
            crate::ssh::emit_log(&self.app, connect_id, kind, message);
        }
    }

    pub fn new(
        app: AppHandle,
        prompts: Arc<PromptState>,
        policy: &str,
        connect_id: Option<String>,
        interactive: bool,
    ) -> Self {
        ConnectSecurity {
            app,
            prompts,
            policy: HostKeyPolicy::from_str(policy),
            connect_id,
            interactive,
            waiting: Arc::new(AtomicBool::new(false)),
        }
    }
}

#[derive(Clone)]
pub struct HostKeyVerifier {
    pub sec: ConnectSecurity,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    /// russh throws away the reason a handler rejected a key (see
    /// `client/mod.rs`: `Session::run` matches `Err(e)` and returns `Ok(())`
    /// with the propagation commented out). The caller would only ever see
    /// "Disconnected", so the real reason is recorded here instead.
    outcome: Arc<StdMutex<Option<String>>>,
    /// Whether this host is a jump host rather than the requested server.
    is_jump: bool,
}

impl HostKeyVerifier {
    pub fn new(sec: ConnectSecurity, host: &str, port: u16, username: Option<String>) -> Self {
        HostKeyVerifier {
            sec,
            host: host.to_string(),
            port,
            username,
            outcome: Arc::new(StdMutex::new(None)),
            is_jump: false,
        }
    }

    /// Marks this as a hop on the way somewhere else, so the prompt can say
    /// which machine it is asking the user to trust.
    pub fn as_jump(mut self) -> Self {
        self.is_jump = true;
        self
    }

    /// The rejection reason, if this verifier turned a key down.
    pub fn failure(&self) -> Option<String> {
        self.outcome.lock().ok().and_then(|g| g.clone())
    }

    fn fail(&self, message: String) {
        self.log("error", &message);
        if let Ok(mut guard) = self.outcome.lock() {
            *guard = Some(message);
        }
    }

    fn log(&self, kind: &str, message: &str) {
        self.sec.log(kind, message);
    }

    fn target(&self) -> String {
        match &self.username {
            Some(u) => format!("{}@{}:{}", u, self.host, self.port),
            None => format!("{}:{}", self.host, self.port),
        }
    }

    pub async fn verify(&self, key: &PublicKey) -> bool {
        let offered_type = key_type(key);
        let offered_fp = fingerprint(key);
        self.log(
            "auth",
            &format!("Checking host key ({} {})", offered_type, offered_fp),
        );

        match check_host(&self.host, self.port, key) {
            KnownHostStatus::Match { source } => {
                self.log(
                    "auth",
                    &format!("Host key verified against {} known_hosts", source.as_str()),
                );
                true
            }

            KnownHostStatus::Revoked => {
                self.fail(format!(
                    "The host key for {} is marked @revoked in known_hosts. Refusing to connect.",
                    self.target()
                ));
                false
            }

            KnownHostStatus::Mismatch {
                source,
                line,
                existing_type,
                existing_fp,
            } => {
                self.fail(format!(
                    "REMOTE HOST IDENTIFICATION HAS CHANGED for {target}.\n\
                     The stored key ({existing_type} {existing_fp}) does not match the key the \
                     server offered ({offered_type} {offered_fp}).\n\
                     Someone could be eavesdropping right now (man-in-the-middle attack), or the \
                     server's host key was changed.\n\
                     Stored in the {source} known_hosts file, line {line}.",
                    target = self.target(),
                    source = source.as_str(),
                ));

                if self.sec.policy != HostKeyPolicy::Ask || !self.sec.interactive {
                    return false;
                }

                let decision = self
                    .ask(
                        "mismatch",
                        &offered_type,
                        &offered_fp,
                        Some(existing_type),
                        Some(existing_fp),
                        Some(source.as_str().to_string()),
                        Some(line),
                    )
                    .await;

                if decision != HostKeyDecision::Replace {
                    return false;
                }
                if let Err(e) = replace_host(&self.host, self.port, key) {
                    self.fail(format!("Could not update known_hosts: {}", e));
                    return false;
                }
                // The rejection reason recorded above no longer applies.
                if let Ok(mut guard) = self.outcome.lock() {
                    *guard = None;
                }
                self.log("auth", "Stored host key replaced by user");
                true
            }

            KnownHostStatus::Unknown => match self.sec.policy {
                HostKeyPolicy::AcceptNew => {
                    if let Err(e) = learn_host(&self.host, self.port, key) {
                        self.fail(format!("Could not write known_hosts: {}", e));
                        return false;
                    }
                    self.log("auth", "New host key accepted and saved (accept-new policy)");
                    true
                }

                HostKeyPolicy::Strict => {
                    self.fail(format!(
                        "The host key for {} is not in known_hosts, and the host key policy is \
                         set to strict. Refusing to connect.",
                        self.target()
                    ));
                    false
                }

                HostKeyPolicy::Ask => {
                    if !self.sec.interactive {
                        self.fail(format!(
                            "The host key for {} is not in known_hosts. Connect a terminal \
                             session first to review and trust it.",
                            self.target()
                        ));
                        return false;
                    }

                    match self
                        .ask("unknown", &offered_type, &offered_fp, None, None, None, None)
                        .await
                    {
                        HostKeyDecision::Trust => {
                            if let Err(e) = learn_host(&self.host, self.port, key) {
                                self.fail(format!("Could not write known_hosts: {}", e));
                                return false;
                            }
                            self.log("auth", "Host key trusted and saved");
                            true
                        }
                        HostKeyDecision::Once => {
                            self.log("auth", "Host key accepted for this session only");
                            true
                        }
                        _ => {
                            self.fail(format!(
                                "Host key for {} was rejected.",
                                self.target()
                            ));
                            false
                        }
                    }
                }
            },
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn ask(
        &self,
        status: &str,
        key_type: &str,
        fingerprint: &str,
        existing_key_type: Option<String>,
        existing_fingerprint: Option<String>,
        source: Option<String>,
        line: Option<usize>,
    ) -> HostKeyDecision {
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.sec
            .prompts
            .host_keys
            .lock()
            .await
            .insert(request_id.clone(), tx);

        let event = HostKeyPromptEvent {
            request_id: request_id.clone(),
            connect_id: self.sec.connect_id.clone(),
            host: self.host.clone(),
            port: self.port,
            username: self.username.clone(),
            status: status.to_string(),
            key_type: key_type.to_string(),
            fingerprint: fingerprint.to_string(),
            existing_key_type,
            existing_fingerprint,
            source,
            line,
            is_jump: self.is_jump,
        };

        self.sec.waiting.store(true, Ordering::Relaxed);
        let _ = self.sec.app.emit("host-key-prompt", event);

        let decision = match timeout(Duration::from_secs(300), rx).await {
            Ok(Ok(d)) => d,
            // Timed out, or the sender was dropped without an answer.
            _ => HostKeyDecision::Reject,
        };

        self.sec.waiting.store(false, Ordering::Relaxed);
        self.sec.prompts.host_keys.lock().await.remove(&request_id);
        // Retract the modal if we gave up before the user answered.
        let _ = self
            .sec
            .app
            .emit("host-key-prompt-cancel", PromptCancelEvent { request_id });

        decision
    }
}

/// The single `client::Handler` used by every connect path in the app.
pub struct VerifyingHandler {
    pub v: HostKeyVerifier,
}

#[async_trait]
impl client::Handler for VerifyingHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKey) -> Result<bool, Self::Error> {
        Ok(self.v.verify(key).await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Fixtures produced by real `ssh-keygen`, so a drift from OpenSSH's own
    // hashing or host-spec rules fails the test rather than failing open.
    const ED25519_B64: &str = "AAAAC3NzaC1lZDI1NTE5AAAAIJ4G1Q7fdnbtjJPJKG35nnBLpUBvsqJzvfaAcqWlZS5u";
    // `ssh-keygen -H` over the line `example.com <key>`
    const HASHED_22: &str = "|1|unPRxDhamqo3tS9rAHTxFiDZeoc=|xxvdP4lgIdPNXMdbWTRxoTcuDFA=";
    // `ssh-keygen -H` over the line `[example.com]:2222 <key>`
    const HASHED_2222: &str = "|1|1oKhcudrU6zWbNm2s44pmYNsptk=|ZWLiojZEzmoz8LDmzg8HegLZ8pA=";

    #[test]
    fn fingerprint_matches_ssh_keygen() {
        let blob = B64.decode(ED25519_B64).unwrap();
        assert_eq!(
            fingerprint_from_blob(&blob),
            "SHA256:BZpjiB9yqu9UsdcMZfJ/is2DOjRTZmTnZZ09hnmtcnQ"
        );
        assert_eq!(algo_from_blob(&blob).unwrap(), "ssh-ed25519");
    }

    #[test]
    fn algo_from_blob_rejects_junk() {
        assert!(algo_from_blob(&[]).is_none());
        assert!(algo_from_blob(&[0, 0, 0, 9, b'x']).is_none()); // length runs past the end
        assert!(algo_from_blob(&[0xff, 0xff, 0xff, 0xff]).is_none()); // absurd length
    }

    #[test]
    fn host_spec_follows_openssh() {
        assert_eq!(host_spec("example.com", 22), "example.com");
        assert_eq!(host_spec("example.com", 2222), "[example.com]:2222");
    }

    #[test]
    fn hashed_entries_match_only_their_host() {
        assert!(host_matches(HASHED_22, "example.com"));
        assert!(!host_matches(HASHED_22, "evil.com"));
        // A port-22 hash must not satisfy a lookup for the same host on 2222.
        assert!(!host_matches(HASHED_22, "[example.com]:2222"));

        assert!(host_matches(HASHED_2222, "[example.com]:2222"));
        assert!(!host_matches(HASHED_2222, "example.com"));
    }

    #[test]
    fn malformed_hashed_entries_do_not_match() {
        assert!(!host_matches("|1|notbase64!!|alsobad", "example.com"));
        assert!(!host_matches("|1|onlyonefield", "example.com"));
        assert!(!host_matches("|2|unPRxDhamqo3tS9rAHTxFiDZeoc=|x", "example.com"));
    }

    #[test]
    fn plain_and_glob_patterns() {
        assert!(host_matches("example.com", "example.com"));
        assert!(!host_matches("example.com", "example.como"));
        assert!(!host_matches("example.com", "notexample.com"));
        assert!(host_matches("a.com,b.com", "b.com"));
        assert!(host_matches("*.example.com", "host.example.com"));
        assert!(!host_matches("*.example.com", "example.com"));
        assert!(host_matches("web?.example.com", "web1.example.com"));
        assert!(!host_matches("web?.example.com", "web12.example.com"));
    }

    #[test]
    fn negation_overrides_a_match() {
        assert!(!host_matches("*.example.com,!secret.example.com", "secret.example.com"));
        assert!(host_matches("*.example.com,!secret.example.com", "public.example.com"));
    }

    #[test]
    fn glob_backtracks() {
        assert!(glob_match("*.com", "a.b.com"));
        assert!(glob_match("a*b*c", "axxbyyc"));
        assert!(!glob_match("a*b*c", "axxbyy"));
        assert!(glob_match("*", "anything"));
        assert!(glob_match("**", "anything"));
        assert!(!glob_match("", "x"));
        assert!(glob_match("", ""));
    }

    #[test]
    fn scan_skips_comments_and_reads_markers() {
        let dir = std::env::temp_dir().join(format!("bifrossh-kh-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("known_hosts");
        fs::write(
            &path,
            format!(
                "# a comment\n\n\
                 example.com ssh-ed25519 {k}\n\
                 @revoked bad.com ssh-ed25519 {k}\n\
                 truncated.com ssh-ed25519\n",
                k = ED25519_B64
            ),
        )
        .unwrap();

        let lines = scan(&path);
        assert_eq!(lines.len(), 2, "comment, blank and truncated lines dropped");
        assert_eq!(lines[0].hosts, "example.com");
        assert_eq!(lines[0].marker, None);
        assert_eq!(lines[0].line_no, 3);
        assert_eq!(lines[1].hosts, "bad.com");
        assert_eq!(lines[1].marker.as_deref(), Some("@revoked"));

        fs::remove_dir_all(&dir).ok();
    }

    /// Full learn/check/replace/forget lifecycle against a scratch HOME, with
    /// real `ssh-keygen -F` confirming OpenSSH can read what we wrote.
    ///
    /// Sets $HOME, so it must be the only test that does.
    #[test]
    fn lifecycle_and_openssh_interop() {
        let home = std::env::temp_dir().join(format!("bifrossh-life-{}", std::process::id()));
        fs::create_dir_all(&home).unwrap();
        std::env::set_var("HOME", &home);

        let key = russh_keys::parse_public_key_base64(ED25519_B64).unwrap();
        let other = russh_keys::parse_public_key_base64(
            "AAAAC3NzaC1lZDI1NTE5AAAAIKVzUtT1FbaJVeq0mNJlJEZlLmJPYcbFPUZDzKgHLQvE",
        )
        .unwrap();

        // Unknown until learned.
        assert!(matches!(
            check_host("example.com", 2222, &key),
            KnownHostStatus::Unknown
        ));

        learn_host("example.com", 2222, &key).unwrap();
        assert!(matches!(
            check_host("example.com", 2222, &key),
            KnownHostStatus::Match { .. }
        ));

        // Learning twice must not duplicate the line.
        learn_host("example.com", 2222, &key).unwrap();
        assert_eq!(list_known_hosts().unwrap().len(), 1);

        let path = bifrossh_known_hosts_path().unwrap();

        // OpenSSH's own parser must find the entry we wrote.
        let found = std::process::Command::new("ssh-keygen")
            .args(["-F", "[example.com]:2222", "-f"])
            .arg(&path)
            .output()
            .expect("ssh-keygen must be installed to run this test");
        assert!(
            found.status.success() && !found.stdout.is_empty(),
            "ssh-keygen could not read our known_hosts: {}",
            String::from_utf8_lossy(&found.stderr)
        );

        // File must not be group/world readable.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o077, 0, "known_hosts must be 0600");
        }

        // A different key for the same host is a mismatch, not a silent accept.
        match check_host("example.com", 2222, &other) {
            KnownHostStatus::Mismatch { existing_fp, .. } => {
                assert_eq!(existing_fp, fingerprint(&key));
            }
            s => panic!("expected mismatch, got {:?}", s),
        }

        // The same key on a different port is a separate, unknown host.
        assert!(matches!(
            check_host("example.com", 22, &key),
            KnownHostStatus::Unknown
        ));

        replace_host("example.com", 2222, &other).unwrap();
        assert!(matches!(
            check_host("example.com", 2222, &other),
            KnownHostStatus::Match { .. }
        ));
        assert_eq!(
            list_known_hosts().unwrap().len(),
            1,
            "replace must not leave the old line behind"
        );

        assert_eq!(forget_host("example.com", 2222).unwrap(), 1);
        assert!(matches!(
            check_host("example.com", 2222, &other),
            KnownHostStatus::Unknown
        ));

        // Migration path: a host already trusted in ~/.ssh/known_hosts must
        // verify without prompting, and be mirrored into our own file so the
        // app keeps working if that file goes away.
        let ssh_dir = home.join(".ssh");
        fs::create_dir_all(&ssh_dir).unwrap();
        fs::write(
            ssh_dir.join("known_hosts"),
            format!(
                "# OpenSSH's own file\n\
                 legacy.example.com ssh-dss AAAAB3NzaC1kc3MAAACBAJunk\n\
                 legacy.example.com ssh-ed25519 {}\n",
                ED25519_B64
            ),
        )
        .unwrap();

        assert!(
            matches!(
                check_host("legacy.example.com", 22, &key),
                KnownHostStatus::Match {
                    source: HostKeySource::OpenSsh
                }
            ),
            "an unsupported ssh-dss line above must not block the match"
        );

        // Mirrored, so it now exists in both files — but the list must show it
        // once, attributed to the file the user can edit.
        let listed: Vec<_> = list_known_hosts()
            .unwrap()
            .into_iter()
            .filter(|e| e.host == "legacy.example.com")
            .collect();
        assert_eq!(listed.len(), 1, "mirrored host must not be listed twice");
        assert_eq!(listed[0].source, "bifrossh");

        fs::remove_file(ssh_dir.join("known_hosts")).unwrap();
        assert!(
            matches!(
                check_host("legacy.example.com", 22, &key),
                KnownHostStatus::Match {
                    source: HostKeySource::Bifrossh
                }
            ),
            "the OpenSSH entry should have been mirrored across"
        );

        // Export and re-import against the real file: what comes out must go
        // back in as a no-op, and only our own file may travel.
        let exported = export_lines().unwrap();
        assert!(
            exported.iter().any(|l| l.contains("legacy.example.com")),
            "the mirrored entry should be in the export"
        );
        assert!(
            !exported.iter().any(|l| l.contains("ssh-dss")),
            "~/.ssh/known_hosts must not be carried into an export"
        );

        let before = fs::read_to_string(bifrossh_known_hosts_path().unwrap()).unwrap();
        let again = import_lines(&exported).unwrap();
        assert_eq!(again.added, 0);
        assert_eq!(again.skipped, exported.len());
        assert_eq!(
            fs::read_to_string(bifrossh_known_hosts_path().unwrap()).unwrap(),
            before,
            "re-importing an export of ourselves must not touch the file"
        );

        let fresh = import_lines(&[format!(
            "imported.example ssh-ed25519 {}",
            ED25519_B64
        )])
        .unwrap();
        assert_eq!(fresh.added, 1);
        assert!(matches!(
            check_host("imported.example", 22, &key),
            KnownHostStatus::Match { .. }
        ));

        fs::remove_dir_all(&home).ok();
    }

    #[test]
    fn split_host_spec_roundtrips() {
        assert_eq!(split_host_spec("example.com"), ("example.com".into(), 22));
        assert_eq!(
            split_host_spec("[example.com]:2222"),
            ("example.com".into(), 2222)
        );
        assert_eq!(
            split_host_spec("[::1]:2222"),
            ("::1".into(), 2222),
            "IPv6 literals keep their inner brackets stripped correctly"
        );
    }

    /// The same algorithm, different key material.
    fn other_key_b64() -> String {
        let mut blob = B64.decode(ED25519_B64).unwrap();
        *blob.last_mut().unwrap() ^= 0xff;
        B64.encode(blob)
    }

    fn line(host: &str, b64: &str) -> String {
        format!("{host} ssh-ed25519 {b64}")
    }

    #[test]
    fn importing_hosts_adds_only_what_is_new() {
        let existing = format!("{}\n", line("alpha.example", ED25519_B64));
        let incoming = vec![
            line("alpha.example", ED25519_B64),
            line("beta.example", ED25519_B64),
        ];

        let (report, pending) = merge_lines(&existing, &incoming);
        assert_eq!(report.added, 1);
        assert_eq!(report.skipped, 1);
        assert!(report.conflicts.is_empty());
        assert_eq!(pending, vec![line("beta.example", ED25519_B64)]);
    }

    #[test]
    fn a_different_key_for_a_known_host_is_a_conflict_not_a_replacement() {
        let existing = format!("{}\n", line("alpha.example", ED25519_B64));
        let incoming = vec![line("alpha.example", &other_key_b64())];

        let (report, pending) = merge_lines(&existing, &incoming);
        assert_eq!(report.added, 0);
        assert_eq!(report.conflicts, vec!["alpha.example".to_string()]);
        assert!(
            pending.is_empty(),
            "a conflicting identity must never be written"
        );
    }

    #[test]
    fn a_file_repeating_a_host_only_takes_the_first() {
        let incoming = vec![
            line("alpha.example", ED25519_B64),
            line("alpha.example", ED25519_B64),
            line("alpha.example", &other_key_b64()),
        ];

        let (report, pending) = merge_lines("", &incoming);
        assert_eq!(report.added, 1);
        assert_eq!(report.skipped, 1);
        assert_eq!(report.conflicts.len(), 1);
        assert_eq!(pending.len(), 1);
    }

    #[test]
    fn unreadable_lines_are_skipped_rather_than_written_through() {
        let incoming = vec![
            "this is not a known_hosts line".to_string(),
            "alpha.example ssh-ed25519 !!!notbase64".to_string(),
            "# a comment".to_string(),
            String::new(),
        ];

        let (report, pending) = merge_lines("", &incoming);
        assert_eq!(report.added, 0);
        assert_eq!(report.skipped, 2, "the comment and blank do not count");
        assert!(pending.is_empty());
    }

    #[test]
    fn the_same_host_on_two_ports_is_two_entries() {
        let incoming = vec![
            line("alpha.example", ED25519_B64),
            line("[alpha.example]:2222", ED25519_B64),
        ];

        let (report, pending) = merge_lines("", &incoming);
        assert_eq!(report.added, 2);
        assert_eq!(pending.len(), 2);
    }
}
