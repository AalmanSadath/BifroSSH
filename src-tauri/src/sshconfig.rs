//! Reads hosts out of an OpenSSH client config so they can be imported.
//!
//! Deliberately a reader, not an implementation of ssh_config: only the
//! directives that map onto a BifroSSH host are understood, and anything else
//! is ignored rather than guessed at.

use std::path::PathBuf;

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
    /// `Include` directives are not followed. Reported so a partial import is
    /// visible rather than silently missing hosts.
    pub has_includes: bool,
}

pub fn config_path() -> Option<PathBuf> {
    let path = dirs::home_dir()?.join(".ssh").join("config");
    path.exists().then_some(path)
}

fn expand_home(value: &str) -> String {
    if let Some(rest) = value.strip_prefix("~/") {
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

pub fn parse(content: &str) -> SshConfigScan {
    let mut hosts: Vec<SshConfigHost> = Vec::new();
    let mut has_includes = false;
    // Aliases sharing one Host line all receive the directives that follow.
    let mut current: Vec<usize> = Vec::new();

    for line in content.lines() {
        let Some((key, value)) = split_directive(line) else { continue };

        match key.as_str() {
            "include" => has_includes = true,
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

    SshConfigScan { hosts, has_includes }
}

/// The host part of a `ProxyJump` value, which OpenSSH allows to be written
/// as `[user@]host[:port]`. Only the host is of use here: the import links a
/// jump to a saved server, and that server already carries its own username
/// and port.
///
/// A comma-separated multi-hop value gives back the first hop only, which is
/// the one the connection is made through first.
pub fn jump_alias(proxy_jump: &str) -> Option<&str> {
    let first = proxy_jump.split(',').next()?.trim();
    if first.is_empty() || first.eq_ignore_ascii_case("none") {
        return None;
    }
    let after_user = first.rsplit('@').next()?;
    // A bracketed IPv6 literal keeps its colons; anything else splits on the
    // last colon to drop a port.
    let host = if after_user.starts_with('[') {
        after_user.split(']').next()?.trim_start_matches('[')
    } else {
        after_user.rsplit_once(':').map_or(after_user, |(host, _)| host)
    };
    (!host.is_empty()).then_some(host)
}

pub fn scan() -> Result<SshConfigScan, String> {
    let Some(path) = config_path() else {
        return Ok(SshConfigScan { hosts: Vec::new(), has_includes: false });
    };
    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("{}: {}", path.display(), e))?;
    Ok(parse(&content))
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

    #[test]
    fn includes_are_reported_rather_than_followed() {
        let scan = parse("Include ~/.ssh/config.d/*\nHost web\n  HostName example.com\n");
        assert!(scan.has_includes, "a partial import must be visible");
        assert_eq!(scan.hosts.len(), 1);
    }

    #[test]
    fn proxy_jump_is_recorded_so_it_can_be_linked() {
        let scan = parse("Host inner\n  HostName 10.0.0.5\n  ProxyJump bastion\n");
        assert_eq!(scan.hosts[0].proxy_jump.as_deref(), Some("bastion"));
    }

    #[test]
    fn a_bare_jump_alias_is_its_own_host() {
        assert_eq!(jump_alias("bastion"), Some("bastion"));
    }

    #[test]
    fn a_jump_alias_drops_the_user_and_port_around_it() {
        assert_eq!(jump_alias("jane@bastion"), Some("bastion"));
        assert_eq!(jump_alias("bastion:2222"), Some("bastion"));
        assert_eq!(jump_alias("jane@bastion:2222"), Some("bastion"));
    }

    /// A bracketed IPv6 literal is full of colons that are not a port.
    #[test]
    fn a_jump_alias_keeps_an_ipv6_literal_intact() {
        assert_eq!(jump_alias("[2001:db8::1]:2222"), Some("2001:db8::1"));
        assert_eq!(jump_alias("[2001:db8::1]"), Some("2001:db8::1"));
    }

    /// Multi-hop chains are written `a,b,c`; the first is what is dialled first.
    #[test]
    fn a_multi_hop_jump_alias_gives_back_the_first_hop() {
        assert_eq!(jump_alias("outer,inner"), Some("outer"));
    }

    /// `ProxyJump none` is how a later block cancels an inherited jump host.
    #[test]
    fn a_jump_alias_of_none_is_not_a_host() {
        assert_eq!(jump_alias("none"), None);
        assert_eq!(jump_alias("None"), None);
        assert_eq!(jump_alias("  "), None);
    }

    #[test]
    fn a_bad_port_does_not_discard_the_host() {
        let scan = parse("Host web\n  HostName example.com\n  Port notanumber\n");
        assert_eq!(scan.hosts.len(), 1);
        assert_eq!(scan.hosts[0].port, None);
    }
}
