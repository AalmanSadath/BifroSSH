//! PuTTY, which keeps its sessions in two different places.
//!
//! On Windows they are registry keys, and what leaves the machine is a
//! `regedit` export: UTF-16LE with a byte order mark, one section per session,
//! the session's name percent-escaped in the section header. On Unix each
//! session is a file of `key=value` lines under `~/.putty/sessions`, named the
//! same escaped way.
//!
//! Both are read here, since both are PuTTY and a user has no reason to care
//! which one their file is.

use anyhow::{anyhow, Result};

use super::{port_or_default, ForeignHost, ForeignScan, Source};

/// The registry path PuTTY's sessions live under, as a `.reg` export writes it.
const SESSIONS: &str = r"\SimonTatham\PuTTY\Sessions\";

/// A regedit export, whichever encoding it is in, or a single session file.
pub(super) fn looks_like(bytes: &[u8]) -> bool {
    let text = decode_utf16_or_else(bytes);
    text.contains(SESSIONS) || is_session_file(&text)
}

/// One session file rather than an export of all of them: see
/// [`super::is_one_putty_session`].
pub(super) fn is_lone_session(bytes: &[u8]) -> bool {
    let text = decode_utf16_or_else(bytes);
    !text.contains(SESSIONS) && is_session_file(&text)
}

/// A session file has no sections and names the two settings every PuTTY
/// session has. Read without the registry path, a bare `key=value` file is
/// otherwise indistinguishable from any other ini.
fn is_session_file(text: &str) -> bool {
    let mut has_host = false;
    let mut has_protocol = false;
    for line in text.lines() {
        if line.starts_with('[') {
            return false;
        }
        let Some((key, _)) = line.split_once('=') else { continue };
        match key.trim() {
            "HostName" => has_host = true,
            "Protocol" => has_protocol = true,
            _ => {}
        }
    }
    has_host && has_protocol
}

pub(super) fn parse(bytes: &[u8]) -> Result<ForeignScan> {
    let text = decode_utf16_or_else(bytes);
    let hosts_and_skips = if text.contains(SESSIONS) {
        parse_reg(&text)
    } else {
        // One file is one session, and its name is not in it: the file is
        // named for the session. The caller supplies the name by reading the
        // directory, so a lone file imports as the address it points at.
        parse_session(&text, None).map_or_else(|why| (Vec::new(), vec![why]), |h| (vec![h], Vec::new()))
    };
    let (hosts, skipped) = hosts_and_skips;
    if hosts.is_empty() && skipped.is_empty() {
        return Err(anyhow!("There are no PuTTY sessions in this file."));
    }
    Ok(ForeignScan { source: Source::Putty, hosts, skipped })
}

/// One session out of a set of `key=value` lines, named for its file when the
/// caller knows the name.
pub(super) fn parse_session(text: &str, name: Option<&str>) -> Result<ForeignHost, String> {
    let mut settings = Settings::default();
    for line in text.lines() {
        if let Some((key, value)) = line.split_once('=') {
            settings.take(key.trim(), value.trim());
        }
    }
    settings.into_host(name.map(unescape_name))
}

/// The sections of a regedit export, one per session.
fn parse_reg(text: &str) -> (Vec<ForeignHost>, Vec<String>) {
    let mut hosts = Vec::new();
    let mut skipped = Vec::new();
    let mut current: Option<(String, Settings)> = None;

    let finish = |current: Option<(String, Settings)>,
                  hosts: &mut Vec<ForeignHost>,
                  skipped: &mut Vec<String>| {
        if let Some((name, settings)) = current {
            match settings.into_host(Some(name)) {
                Ok(host) => hosts.push(host),
                Err(why) => skipped.push(why),
            }
        }
    };

    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix('[') {
            finish(current.take(), &mut hosts, &mut skipped);
            // A section for something else PuTTY stores, such as its own
            // settings or the host keys it has seen.
            // An empty name is the sessions key itself rather than a session
            // in it, which a nested export writes as its first line.
            if let Some(name) = rest.trim_end_matches(']').split(SESSIONS).nth(1).filter(|n| !n.is_empty()) {
                current = Some((unescape_name(name), Settings::default()));
            }
            continue;
        }
        let Some((_, settings)) = current.as_mut() else { continue };
        // "Key"="value" and "Key"=dword:0000001a, which is how regedit writes
        // a string and a number.
        let Some((key, value)) = line.split_once('=') else { continue };
        settings.take(key.trim().trim_matches('"'), value.trim());
    }
    finish(current, &mut hosts, &mut skipped);
    (hosts, skipped)
}

/// The three settings worth reading, gathered before it is known whether the
/// session is one this app can open.
#[derive(Default)]
struct Settings {
    host: Option<String>,
    port: Option<String>,
    username: Option<String>,
    protocol: Option<String>,
}

impl Settings {
    fn take(&mut self, key: &str, value: &str) {
        let slot = match key {
            "HostName" => &mut self.host,
            "PortNumber" => &mut self.port,
            "UserName" => &mut self.username,
            "Protocol" => &mut self.protocol,
            _ => return,
        };
        let value = reg_value(value);
        *slot = (!value.is_empty()).then_some(value);
    }

    /// The session as a host, or a sentence saying why it is not one.
    fn into_host(self, name: Option<String>) -> Result<ForeignHost, String> {
        let named = |what: &str| format!("{} {what}", name.clone().unwrap_or_else(|| "A session".into()));
        // PuTTY is a telnet, rlogin, serial and raw client as well, and those
        // sessions sit in the same export.
        if let Some(protocol) = self.protocol.as_deref().filter(|p| !p.eq_ignore_ascii_case("ssh")) {
            return Err(named(&format!("is {protocol}, not ssh")));
        }
        let host = self.host.ok_or_else(|| named("has no address"))?;
        Ok(ForeignHost {
            name: name.unwrap_or_else(|| host.clone()),
            port: self.port.as_deref().map(port_or_default).unwrap_or(22),
            host,
            username: self.username,
            password: None,
            // PuTTY has no folders. Its session names carry the hierarchy
            // people wanted, and splitting on a convention it does not
            // enforce would invent groups nobody asked for.
            group: None,
            tags: Vec::new(),
            notes: None,
        })
    }
}

/// A registry value as regedit writes it: a quoted string, or `dword:` and hex.
fn reg_value(raw: &str) -> String {
    if let Some(hex) = raw.strip_prefix("dword:") {
        return u32::from_str_radix(hex.trim(), 16).map(|n| n.to_string()).unwrap_or_default();
    }
    let raw = raw.trim();
    if raw.starts_with('"') && raw.ends_with('"') && raw.len() >= 2 {
        return unescape_string(&raw[1..raw.len() - 1]);
    }
    raw.to_string()
}

/// `\\` and `\"` inside a quoted registry value.
fn unescape_string(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        match c {
            '\\' => out.extend(chars.next()),
            _ => out.push(c),
        }
    }
    out
}

/// A session name as PuTTY stores it, with `%20` for a space and `%25` for a
/// per cent sign. Anything that is not a valid escape stays as it was.
fn unescape_name(name: &str) -> String {
    let bytes = name.as_bytes();
    let mut out = String::with_capacity(name.len());
    let mut i = 0;
    while i < bytes.len() {
        let escape = (bytes[i] == b'%' && i + 2 < bytes.len())
            .then(|| u8::from_str_radix(&name[i + 1..i + 3], 16).ok())
            .flatten();
        match escape {
            Some(byte) => {
                out.push(byte as char);
                i += 3;
            }
            None => {
                out.push(bytes[i] as char);
                i += 1;
            }
        }
    }
    out
}

/// UTF-16LE when the file begins with a byte order mark, which is what regedit
/// writes, and the caller's own decoding otherwise.
fn decode_utf16_or_else(bytes: &[u8]) -> String {
    if bytes.len() < 2 || bytes[0] != 0xff || bytes[1] != 0xfe {
        return super::decode(bytes);
    }
    // An odd trailing byte is a truncated file; the last half character is
    // dropped rather than the whole file being refused, since everything
    // before it is still sessions.
    let units: Vec<u16> = bytes[2..]
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| u16::from_le_bytes(*pair))
        .collect();
    String::from_utf16_lossy(&units)
}

#[cfg(test)]
mod tests {
    use super::*;

    const REG: &str = r#"Windows Registry Editor Version 5.00

[HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\prod%20db]
"HostName"="db.example.com"
"PortNumber"=dword:0000116f
"UserName"="deploy"
"Protocol"="ssh"

[HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\switch]
"HostName"="10.0.0.9"
"Protocol"="telnet"

[HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\web]
"HostName"="10.0.0.1"
"Protocol"="ssh"
"#;

    /// Regedit writes UTF-16LE with a byte order mark, which is the form a
    /// file coming off a Windows machine actually takes.
    fn as_utf16(text: &str) -> Vec<u8> {
        let mut bytes = vec![0xff, 0xfe];
        for unit in text.encode_utf16() {
            bytes.extend_from_slice(&unit.to_le_bytes());
        }
        bytes
    }

    #[test]
    fn a_utf16_export_reads_every_ssh_session() {
        let scan = parse(&as_utf16(REG)).unwrap();
        assert_eq!(scan.hosts.len(), 2);
        let db = &scan.hosts[0];
        // The name is unescaped, and a dword port is hex.
        assert_eq!(db.name, "prod db");
        assert_eq!(db.host, "db.example.com");
        assert_eq!(db.port, 4463);
        assert_eq!(db.username.as_deref(), Some("deploy"));
        assert_eq!(scan.hosts[1].name, "web");
        assert_eq!(scan.hosts[1].port, 22);
        assert_eq!(scan.skipped, vec!["switch is telnet, not ssh"]);
    }

    /// The same file saved as UTF-8, which is what an editor does to it.
    #[test]
    fn the_same_export_in_utf8_reads_the_same() {
        let utf8 = parse(REG.as_bytes()).unwrap();
        let utf16 = parse(&as_utf16(REG)).unwrap();
        assert_eq!(utf8.hosts, utf16.hosts);
    }

    #[test]
    fn a_section_for_something_other_than_a_session_is_passed_over() {
        let text = r#"[HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\SshHostKeys]
"rsa2@22:10.0.0.1"="0x23,0xabc"

[HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\web]
"HostName"="10.0.0.1"
"Protocol"="ssh"
"#;
        let scan = parse(text.as_bytes()).unwrap();
        assert_eq!(scan.hosts.len(), 1);
        assert_eq!(scan.hosts[0].host, "10.0.0.1");
    }

    #[test]
    fn a_session_with_no_address_is_named_rather_than_dropped() {
        let text = r#"[HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\Default%20Settings]
"Protocol"="ssh"
"UserName"="root"
"#;
        let scan = parse(text.as_bytes()).unwrap();
        assert!(scan.hosts.is_empty());
        assert_eq!(scan.skipped, vec!["Default Settings has no address"]);
    }

    /// PuTTY on Unix: one file per session, no sections, and the name is the
    /// file's rather than anything inside it.
    #[test]
    fn a_unix_session_file_reads_on_its_own() {
        let text = "Protocol=ssh\nHostName=10.0.0.4\nPortNumber=2222\nUserName=root\n";
        assert!(looks_like(text.as_bytes()));
        let host = parse_session(text, Some("prod%20web")).unwrap();
        assert_eq!(host.name, "prod web");
        assert_eq!((host.host.as_str(), host.port), ("10.0.0.4", 2222));
        // Read without its filename, the address is the only name it has.
        assert_eq!(parse(text.as_bytes()).unwrap().hosts[0].name, "10.0.0.4");
    }

    #[test]
    fn an_escaped_value_loses_its_backslashes() {
        assert_eq!(reg_value(r#""C:\\Users\\me""#), r"C:\Users\me");
        assert_eq!(reg_value(r#""say \"hi\"""#), r#"say "hi""#);
        assert_eq!(reg_value("dword:00000016"), "22");
        assert_eq!(reg_value("dword:zzz"), "");
    }

    #[test]
    fn a_name_keeps_a_per_cent_that_is_not_an_escape() {
        assert_eq!(unescape_name("100%25 done"), "100% done");
        assert_eq!(unescape_name("50% off"), "50% off");
        assert_eq!(unescape_name("plain"), "plain");
    }

    /// Half a character at the end is a truncated download, and everything
    /// before it is still sessions worth importing.
    #[test]
    fn a_truncated_utf16_file_keeps_what_it_has() {
        let mut bytes = as_utf16(REG);
        bytes.pop();
        let scan = parse(&bytes).unwrap();
        assert_eq!(scan.hosts.len(), 2);
    }

    /// The directory form: the name comes from the file, so reading the
    /// directory is the only way to get it.
    #[test]
    fn a_sessions_directory_is_read_as_a_set() {
        let files = vec![
            ("prod%20web".to_string(), b"Protocol=ssh\nHostName=10.0.0.4\n".to_vec()),
            ("console".to_string(), b"Protocol=serial\nHostName=COM1\n".to_vec()),
        ];
        let scan = super::super::parse_putty_dir(&files);
        assert_eq!(scan.hosts.len(), 1);
        assert_eq!(scan.hosts[0].name, "prod web");
        assert_eq!(scan.skipped, vec!["console is serial, not ssh"]);
    }

    #[test]
    fn only_a_lone_session_file_asks_for_its_directory() {
        assert!(super::super::is_one_putty_session(b"Protocol=ssh\nHostName=10.0.0.4\n"));
        assert!(!super::super::is_one_putty_session(REG.as_bytes()));
        assert!(!super::super::is_one_putty_session(b"nothing to do with putty"));
    }

    #[test]
    fn a_file_with_no_sessions_says_so() {
        let text = "[HKEY_CURRENT_USER\\Software\\SimonTatham\\PuTTY\\Sessions\\]\n";
        assert!(parse(text.as_bytes()).unwrap_err().to_string().contains("no PuTTY sessions"));
        assert!(!looks_like(b"Protocol=ssh\n"));
        assert!(!looks_like(b"[Bookmarks]\nSubRep=\n"));
    }
}
