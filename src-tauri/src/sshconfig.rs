//! Reads hosts out of an OpenSSH client config so they can be imported.
//!
//! Deliberately a reader, not an implementation of ssh_config: only the
//! directives that map onto a BifroSSH host are understood, and anything else
//! is ignored rather than guessed at.

use anyhow::Context;
use std::path::{Path, PathBuf};

/// One importable host from the config.
#[derive(Debug, Clone, serde::Serialize, PartialEq)]
pub struct SshConfigHost {
    /// The name on the `Host` line, used as the display name.
    pub alias: String,
    /// `HostName`, falling back to the alias when absent, as ssh itself does.
    pub hostname: String,
    pub user: Option<String>,
    pub port: Option<u16>,
    /// `IdentityFile`, expanded but not read.
    pub identity_file: Option<String>,
    /// The config's `ProxyJump` value, verbatim. Linked to a saved server on
    /// import when it names another host being imported alongside it.
    pub proxy_jump: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SshConfigScan {
    pub hosts: Vec<SshConfigHost>,
    /// Files pulled in by `Include`, in the order they were read. Reported so
    /// it is clear where a host came from when it is not in the main config.
    pub included_files: Vec<String>,
    /// Files an `Include` named that could not be read. A pattern matching
    /// nothing is normal and is not in here; a file that exists and will not
    /// open is worth saying, because hosts are missing because of it.
    pub unreadable_includes: Vec<String>,
}

pub fn config_path() -> Option<PathBuf> {
    let path = dirs::home_dir()?.join(".ssh").join("config");
    path.exists().then_some(path)
}

/// `~/` and, on Windows where OpenSSH accepts either separator, `~\`.
fn expand_home(value: &str) -> String {
    if let Some(rest) = value.strip_prefix("~/").or_else(|| value.strip_prefix("~\\")) {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest).to_string_lossy().into_owned();
        }
    }
    value.to_string()
}

/// A pattern rather than a specific host. `Host *` and friends set defaults for
/// other entries, so there is nothing to import from them.
fn is_pattern(alias: &str) -> bool {
    alias.contains('*') || alias.contains('?') || alias.starts_with('!')
}

/// Splits `Keyword value`, also accepting the `Keyword=value` form ssh allows.
fn split_directive(line: &str) -> Option<(String, String)> {
    let line = line.trim();
    if line.is_empty() || line.starts_with('#') {
        return None;
    }
    let (key, value) = match line.split_once('=') {
        // Only treat '=' as the separator when it comes before any whitespace,
        // so paths containing '=' are not mangled.
        Some((k, v)) if !k.trim().contains(char::is_whitespace) => (k, v),
        _ => line.split_once(char::is_whitespace)?,
    };
    let value = value.trim().trim_matches('"');
    if value.is_empty() {
        return None;
    }
    Some((key.trim().to_lowercase(), value.to_string()))
}

/// OpenSSH's own limit, and the reason one exists: a config that includes
/// itself, directly or round a ring of files, would otherwise never finish.
const MAX_INCLUDE_DEPTH: usize = 16;

/// Does `name` match a pattern containing `*` and `?`.
///
/// Only the two wildcards `Include` is written with in practice, matched
/// against a single path component. Hand rolled rather than pulling in a glob
/// crate: a dependency here means regenerating `flatpak/cargo-sources.json`
/// and a CI job that fails until it is, which is a lot for twenty lines.
fn wildcard_match(pattern: &str, name: &str) -> bool {
    let (p, n): (Vec<char>, Vec<char>) = (pattern.chars().collect(), name.chars().collect());
    // Walked with a remembered `*` position rather than recursively, so a
    // pattern of many stars cannot blow the stack or the clock.
    let (mut pi, mut ni) = (0usize, 0usize);
    let (mut star, mut matched) = (None, 0usize);

    while ni < n.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == n[ni]) {
            pi += 1;
            ni += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            matched = ni;
            pi += 1;
        } else if let Some(s) = star {
            // Backtrack: let the last star swallow one more character.
            pi = s + 1;
            matched += 1;
            ni = matched;
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|c| *c == '*')
}

/// The files one `Include` token names, in a stable order.
///
/// `~` is expanded, a relative path resolves against the directory the config
/// sits in, as OpenSSH does for a user config, and a wildcard in the final
/// component is matched against that directory's entries. A pattern matching
/// nothing is normal and gives back nothing.
fn include_targets(token: &str, base: &Path) -> Vec<PathBuf> {
    let expanded = expand_home(token);
    let path = Path::new(&expanded);
    let full = if path.is_absolute() { path.to_path_buf() } else { base.join(path) };

    let Some(name) = full.file_name().and_then(|n| n.to_str()) else { return Vec::new() };
    if !name.contains('*') && !name.contains('?') {
        return vec![full];
    }

    let dir = full.parent().unwrap_or(Path::new(".")).to_path_buf();
    let Ok(read) = std::fs::read_dir(&dir) else { return Vec::new() };
    let mut matches: Vec<PathBuf> = read
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name().to_str().is_some_and(|f| wildcard_match(name, f))
                && e.file_type().map(|t| !t.is_dir()).unwrap_or(false)
        })
        .map(|e| e.path())
        .collect();
    // read_dir order is whatever the filesystem hands back, which would make
    // the same config parse differently on two machines.
    matches.sort();
    matches
}

/// Replaces every `Include` line with the text of the files it names.
///
/// Textual, because that is what OpenSSH does: an included file takes effect
/// at the point of the directive, so a `Host` block opened before it continues
/// to collect directives from inside it. Doing this before `parse` is what
/// keeps `parse` a pure function of its text.
fn expand_includes(
    content: &str,
    base: &Path,
    depth: usize,
    included: &mut Vec<String>,
    unreadable: &mut Vec<String>,
) -> String {
    let mut out = String::with_capacity(content.len());

    for line in content.lines() {
        let include = split_directive(line).filter(|(key, _)| key == "include");
        let Some((_, value)) = include else {
            out.push_str(line);
            out.push('\n');
            continue;
        };

        if depth >= MAX_INCLUDE_DEPTH {
            unreadable.push(format!("{value} (nested more than {MAX_INCLUDE_DEPTH} deep)"));
            continue;
        }

        // One directive may name several files, whitespace separated.
        for token in value.split_whitespace() {
            for path in include_targets(token, base) {
                let display = path.display().to_string();
                // A file reached twice is read twice, as ssh would, but a file
                // that reaches itself is stopped by the depth limit above.
                match std::fs::read_to_string(&path) {
                    Ok(text) => {
                        included.push(display);
                        let next_base = path.parent().unwrap_or(base).to_path_buf();
                        out.push_str(&expand_includes(
                            &text, &next_base, depth + 1, included, unreadable,
                        ));
                    }
                    // A pattern that matched nothing never reaches here. This
                    // is a named file that exists and will not open, or one
                    // that was named outright and is not there.
                    Err(_) => unreadable.push(display),
                }
            }
        }
    }
    out
}

pub fn parse(content: &str) -> SshConfigScan {
    let mut hosts: Vec<SshConfigHost> = Vec::new();
    // Aliases sharing one Host line all receive the directives that follow.
    let mut current: Vec<usize> = Vec::new();

    for line in content.lines() {
        let Some((key, value)) = split_directive(line) else { continue };

        match key.as_str() {
            // Already expanded by `expand_includes` before parsing, and a
            // config parsed straight from text has nothing to expand against.
            "include" => {}
            "host" => {
                current.clear();
                for alias in value.split_whitespace() {
                    if is_pattern(alias) {
                        continue;
                    }
                    current.push(hosts.len());
                    hosts.push(SshConfigHost {
                        alias: alias.to_string(),
                        hostname: alias.to_string(),
                        user: None,
                        port: None,
                        identity_file: None,
                        proxy_jump: None,
                    });
                }
            }
            // `Match` blocks are conditional, so anything after one no longer
            // reliably belongs to the preceding Host.
            "match" => current.clear(),
            _ => {
                for &i in &current {
                    let host = &mut hosts[i];
                    match key.as_str() {
                        "hostname" => host.hostname = value.clone(),
                        "user" => host.user = Some(value.clone()),
                        "port" => host.port = value.parse().ok(),
                        // ssh allows several; the first is the one it offers first.
                        "identityfile" if host.identity_file.is_none() => {
                            host.identity_file = Some(expand_home(&value))
                        }
                        "proxyjump" => host.proxy_jump = Some(value.clone()),
                        _ => {}
                    }
                }
            }
        }
    }

    SshConfigScan { hosts, included_files: Vec::new(), unreadable_includes: Vec::new() }
}

/// The host part of one hop, which OpenSSH allows to be written as
/// `[user@]host[:port]`. Only the host is of use here: the import links a hop
/// to a saved server, and that server already carries its own username and
/// port.
fn hop_host(hop: &str) -> Option<&str> {
    let hop = hop.trim();
    if hop.is_empty() || hop.eq_ignore_ascii_case("none") {
        return None;
    }
    let after_user = hop.rsplit('@').next()?;
    // A bracketed IPv6 literal keeps its colons; anything else splits on the
    // last colon to drop a port.
    let host = if after_user.starts_with('[') {
        after_user.split(']').next()?.trim_start_matches('[')
    } else {
        after_user.rsplit_once(':').map_or(after_user, |(host, _)| host)
    };
    (!host.is_empty()).then_some(host)
}

/// Every hop of a `ProxyJump`, in the order OpenSSH connects them: the first
/// is reached directly and each later one through the hop before it.
///
/// `ProxyJump none` disables it, and gives back nothing. A value whose hops do
/// not all parse gives back nothing either, rather than a chain shorter than
/// the one that was asked for, which would connect through fewer bastions than
/// the config says.
pub fn jump_aliases(proxy_jump: &str) -> Vec<&str> {
    let mut hops = Vec::new();
    for hop in proxy_jump.split(',') {
        match hop_host(hop) {
            Some(host) => hops.push(host),
            None => return Vec::new(),
        }
    }
    hops
}

/// The links to write for one host's `ProxyJump`, or nothing when the chain
/// cannot be honoured as written.
///
/// The config names hops outermost first: `ProxyJump a,b` dials a directly and
/// reaches b through it. A saved server points the other way, at the host it is
/// reached *through*, so the chain comes back reversed: the target through the
/// last hop, that hop through the one before it, and the first hop not at all.
///
/// Nothing is returned when there are no hops, when a hop was not imported
/// alongside the target, or when the chain visits a host twice. A chain
/// missing a hop would connect through fewer bastions than the config asks
/// for, which is worse than an obviously direct host.
pub fn chain_links(
    server_id: &str,
    hops: &[&str],
    by_alias: &std::collections::HashMap<String, String>,
) -> Option<Vec<(String, String)>> {
    // `ProxyJump none`, and anything else jump_aliases refused, is not a chain
    // to link. Without this an empty chain would report itself as linked.
    if hops.is_empty() {
        return None;
    }
    let hop_ids: Vec<String> = hops.iter().map(|h| by_alias.get(*h).cloned()).collect::<Option<_>>()?;

    let mut seen = vec![server_id.to_string()];
    for id in &hop_ids {
        if seen.contains(id) {
            return None;
        }
        seen.push(id.clone());
    }

    let mut links = Vec::with_capacity(hop_ids.len());
    let mut reached = server_id.to_string();
    for through in hop_ids.into_iter().rev() {
        links.push((reached, through.clone()));
        reached = through;
    }
    Some(links)
}

pub fn scan() -> anyhow::Result<SshConfigScan> {
    let Some(path) = config_path() else {
        return Ok(SshConfigScan {
            hosts: Vec::new(),
            included_files: Vec::new(),
            unreadable_includes: Vec::new(),
        });
    };
    let content = std::fs::read_to_string(&path)
        .with_context(|| path.display().to_string())?;
    Ok(scan_content(&content, path.parent().unwrap_or(Path::new(""))))
}

/// The scan of one config's text, with its `Include` directives followed
/// against `base`, the directory that config sits in.
///
/// Split from `scan` so it can be driven from a temporary directory in the
/// tests rather than from the user's real `~/.ssh`.
pub fn scan_content(content: &str, base: &Path) -> SshConfigScan {
    let mut included_files = Vec::new();
    let mut unreadable_includes = Vec::new();
    let flattened = expand_includes(
        content,
        base,
        0,
        &mut included_files,
        &mut unreadable_includes,
    );
    let mut scan = parse(&flattened);
    scan.included_files = included_files;
    scan.unreadable_includes = unreadable_includes;
    scan
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_a_basic_block() {
        let scan = parse(
            "Host web\n  HostName example.com\n  User deploy\n  Port 2222\n",
        );
        assert_eq!(scan.hosts.len(), 1);
        let h = &scan.hosts[0];
        assert_eq!(h.alias, "web");
        assert_eq!(h.hostname, "example.com");
        assert_eq!(h.user.as_deref(), Some("deploy"));
        assert_eq!(h.port, Some(2222));
    }

    /// ssh falls back to the alias when HostName is absent, so `ssh web` works.
    #[test]
    fn hostname_defaults_to_the_alias() {
        let scan = parse("Host example.com\n  User deploy\n");
        assert_eq!(scan.hosts[0].hostname, "example.com");
    }

    /// `Host *` sets defaults for other entries; there is no host to import.
    #[test]
    fn wildcard_blocks_are_not_hosts() {
        let scan = parse("Host *\n  User everyone\n\nHost real\n  HostName r.example.com\n");
        assert_eq!(scan.hosts.len(), 1);
        assert_eq!(scan.hosts[0].alias, "real");
        assert_eq!(scan.hosts[0].user, None, "the wildcard block must not leak in");
    }

    #[test]
    fn one_host_line_can_name_several_aliases() {
        let scan = parse("Host a b\n  User shared\n  Port 2200\n");
        assert_eq!(scan.hosts.len(), 2);
        assert!(scan.hosts.iter().all(|h| h.user.as_deref() == Some("shared")));
        assert!(scan.hosts.iter().all(|h| h.port == Some(2200)));
    }

    #[test]
    fn accepts_equals_and_comments_and_quotes() {
        let scan = parse(
            "# a comment\nHost web\n  HostName=example.com\n  User \"deploy\"\n  # trailing\n",
        );
        assert_eq!(scan.hosts[0].hostname, "example.com");
        assert_eq!(scan.hosts[0].user.as_deref(), Some("deploy"));
    }

    #[test]
    fn keywords_are_case_insensitive() {
        let scan = parse("HOST web\n  hostname example.com\n  USER deploy\n");
        assert_eq!(scan.hosts[0].hostname, "example.com");
        assert_eq!(scan.hosts[0].user.as_deref(), Some("deploy"));
    }

    #[test]
    fn keeps_the_first_identity_file_only() {
        let scan = parse("Host web\n  IdentityFile /a/first\n  IdentityFile /b/second\n");
        assert_eq!(scan.hosts[0].identity_file.as_deref(), Some("/a/first"));
    }

    /// A directive after Match no longer reliably belongs to the Host above it.
    #[test]
    fn match_blocks_end_the_current_host() {
        let scan = parse("Host web\n  User deploy\nMatch host other\n  User wrong\n");
        assert_eq!(scan.hosts[0].user.as_deref(), Some("deploy"));
    }

    struct TempDir(PathBuf);
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn temp_dir(name: &str) -> TempDir {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let id = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir()
            .join(format!("bifrossh-cfg-{}-{}-{}", std::process::id(), name, id));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    #[test]
    fn an_include_brings_in_its_hosts() {
        let dir = temp_dir("include");
        std::fs::write(dir.0.join("extra"), "Host inner\n  HostName 10.0.0.9\n").unwrap();

        let scan = scan_content("Include extra\nHost web\n  HostName example.com\n", &dir.0);

        let names: Vec<&str> = scan.hosts.iter().map(|h| h.alias.as_str()).collect();
        assert_eq!(names, vec!["inner", "web"], "an include takes effect where it is written");
        assert_eq!(scan.included_files.len(), 1);
        assert!(scan.unreadable_includes.is_empty());
    }

    /// `Include config.d/*` is how a config gets split up, and the order has
    /// to be the same on every machine.
    #[test]
    fn a_wildcard_include_reads_every_match_in_order() {
        let dir = temp_dir("glob");
        std::fs::create_dir(dir.0.join("config.d")).unwrap();
        std::fs::write(dir.0.join("config.d/10-a.conf"), "Host a\n").unwrap();
        std::fs::write(dir.0.join("config.d/20-b.conf"), "Host b\n").unwrap();
        std::fs::write(dir.0.join("config.d/notes.txt"), "Host ignored\n").unwrap();

        let scan = scan_content("Include config.d/*.conf\n", &dir.0);

        let names: Vec<&str> = scan.hosts.iter().map(|h| h.alias.as_str()).collect();
        assert_eq!(names, vec!["a", "b"]);
    }

    /// A relative include resolves against the config's own directory, and a
    /// nested one against the directory of the file that wrote it.
    #[test]
    fn includes_nest_and_resolve_relatively() {
        let dir = temp_dir("nested");
        std::fs::create_dir(dir.0.join("d")).unwrap();
        std::fs::write(dir.0.join("d/first"), "Include second\nHost one\n").unwrap();
        std::fs::write(dir.0.join("d/second"), "Host two\n").unwrap();

        let scan = scan_content("Include d/first\n", &dir.0);

        let mut names: Vec<&str> = scan.hosts.iter().map(|h| h.alias.as_str()).collect();
        names.sort();
        assert_eq!(names, vec!["one", "two"]);
        assert_eq!(scan.included_files.len(), 2);
    }

    /// Without the depth limit this never returns.
    #[test]
    fn a_config_that_includes_itself_terminates() {
        let dir = temp_dir("loop");
        std::fs::write(dir.0.join("loop.conf"), "Include loop.conf\nHost web\n").unwrap();

        let scan = scan_content("Include loop.conf\n", &dir.0);

        assert_eq!(scan.hosts.len(), MAX_INCLUDE_DEPTH, "one host per pass before the limit stops it");
        assert!(!scan.unreadable_includes.is_empty(), "and the limit is reported");
    }

    /// A pattern matching nothing is how an empty `config.d` behaves, and is
    /// not a fault worth showing anyone.
    #[test]
    fn an_include_matching_nothing_is_not_an_error() {
        let dir = temp_dir("empty-glob");
        let scan = scan_content("Include config.d/*\nHost web\n", &dir.0);
        assert_eq!(scan.hosts.len(), 1);
        assert!(scan.unreadable_includes.is_empty());
    }

    /// A file named outright and not there is worth reporting: hosts are
    /// missing because of it.
    #[test]
    fn a_named_include_that_is_missing_is_reported() {
        let dir = temp_dir("missing");
        let scan = scan_content("Include gone.conf\nHost web\n", &dir.0);
        assert_eq!(scan.hosts.len(), 1, "the rest of the config still imports");
        assert_eq!(scan.unreadable_includes.len(), 1);
    }

    #[test]
    fn wildcards_match_the_way_a_shell_would() {
        assert!(wildcard_match("*.conf", "10-web.conf"));
        assert!(wildcard_match("*", "anything"));
        assert!(wildcard_match("a?c", "abc"));
        assert!(wildcard_match("*a*b*", "xxayybzz"));
        assert!(!wildcard_match("*.conf", "notes.txt"));
        assert!(!wildcard_match("a?c", "ac"));
        assert!(!wildcard_match("abc", "abcd"));
    }

    #[test]
    fn proxy_jump_is_recorded_so_it_can_be_linked() {
        let scan = parse("Host inner\n  HostName 10.0.0.5\n  ProxyJump bastion\n");
        assert_eq!(scan.hosts[0].proxy_jump.as_deref(), Some("bastion"));
    }

    #[test]
    fn a_bare_jump_alias_is_its_own_host() {
        assert_eq!(jump_aliases("bastion"), vec!["bastion"]);
    }

    #[test]
    fn a_jump_alias_drops_the_user_and_port_around_it() {
        assert_eq!(jump_aliases("jane@bastion"), vec!["bastion"]);
        assert_eq!(jump_aliases("bastion:2222"), vec!["bastion"]);
        assert_eq!(jump_aliases("jane@bastion:2222"), vec!["bastion"]);
    }

    /// A bracketed IPv6 literal is full of colons that are not a port.
    #[test]
    fn a_jump_alias_keeps_an_ipv6_literal_intact() {
        assert_eq!(jump_aliases("[2001:db8::1]:2222"), vec!["2001:db8::1"]);
        assert_eq!(jump_aliases("[2001:db8::1]"), vec!["2001:db8::1"]);
    }

    /// Multi-hop chains are written `a,b,c`; the first is what is dialled
    /// first, and every hop matters. Taking only the first used to turn a two
    /// bastion route into a one bastion route that still claimed to be the
    /// host from the config.
    #[test]
    fn a_multi_hop_jump_gives_back_every_hop_in_order() {
        assert_eq!(jump_aliases("outer,inner"), vec!["outer", "inner"]);
        assert_eq!(
            jump_aliases("jane@outer:22, middle ,[2001:db8::1]:2222"),
            vec!["outer", "middle", "2001:db8::1"],
        );
    }

    /// Better nothing than a chain shorter than the config asks for.
    #[test]
    fn a_chain_with_an_unusable_hop_gives_back_nothing() {
        assert!(jump_aliases("outer,,inner").is_empty());
        assert!(jump_aliases("outer,none").is_empty());
    }

    fn aliases(pairs: &[(&str, &str)]) -> std::collections::HashMap<String, String> {
        pairs.iter().map(|(a, id)| (a.to_string(), id.to_string())).collect()
    }

    /// `ProxyJump a,b` dials a, reaches b through a, and the target through b.
    /// Saved servers point at what they are reached through, so the links come
    /// back the other way round.
    #[test]
    fn a_chain_links_from_the_target_inwards() {
        let by_alias = aliases(&[("a", "id-a"), ("b", "id-b")]);
        let links = chain_links("id-target", &["a", "b"], &by_alias).unwrap();
        assert_eq!(
            links,
            vec![
                ("id-target".to_string(), "id-b".to_string()),
                ("id-b".to_string(), "id-a".to_string()),
            ],
            "the first hop is reached directly and gets no link of its own",
        );
    }

    #[test]
    fn a_single_hop_links_the_target_only() {
        let by_alias = aliases(&[("bastion", "id-b")]);
        let links = chain_links("id-target", &["bastion"], &by_alias).unwrap();
        assert_eq!(links, vec![("id-target".to_string(), "id-b".to_string())]);
    }

    /// Half a chain is worse than none: it would connect through fewer
    /// bastions than the config asks for while looking correct.
    #[test]
    fn a_chain_with_a_hop_that_was_not_imported_links_nothing() {
        let by_alias = aliases(&[("a", "id-a")]);
        assert!(chain_links("id-target", &["a", "b"], &by_alias).is_none());
    }

    #[test]
    fn a_chain_that_visits_a_host_twice_is_refused() {
        let by_alias = aliases(&[("a", "id-a"), ("b", "id-b")]);
        assert!(chain_links("id-target", &["a", "a"], &by_alias).is_none());
        assert!(
            chain_links("id-a", &["a", "b"], &by_alias).is_none(),
            "a host reached through itself is a loop",
        );
    }

    /// Without this an empty chain reports itself as linked, and the import
    /// claims a jump it did not make.
    #[test]
    fn an_empty_chain_is_not_a_link() {
        assert!(chain_links("id-target", &[], &aliases(&[])).is_none());
    }

    /// `ProxyJump none` is how a later block cancels an inherited jump host.
    #[test]
    fn a_jump_alias_of_none_is_not_a_host() {
        assert!(jump_aliases("none").is_empty());
        assert!(jump_aliases("None").is_empty());
        assert!(jump_aliases("  ").is_empty());
    }

    #[test]
    fn a_bad_port_does_not_discard_the_host() {
        let scan = parse("Host web\n  HostName example.com\n  Port notanumber\n");
        assert_eq!(scan.hosts.len(), 1);
        assert_eq!(scan.hosts[0].port, None);
    }
}
