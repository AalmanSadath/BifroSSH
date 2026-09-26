//! Reads saved hosts out of another SSH client's export.
//!
//! One reader per client, one shape out. Each reader is pure text work over bytes the
//! caller has already read, so every one of them is tested from a string
//! rather than from a file the test had to write, which is how `sshconfig.rs`
//! is arranged for the same reason.
//!
//! None of these formats is documented by its vendor. Each reader takes what
//! it is sure of, name, address, port, user, folder, and leaves the rest: a
//! guess at a field would be silently wrong, and the host would connect
//! somewhere nobody asked for.

mod csvfile;
mod mobaxterm;
mod putty;
mod termius;

use anyhow::{anyhow, Result};

/// Which client wrote the file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    Termius,
    Putty,
    MobaXterm,
}

/// One host as the other client had it.
#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct ForeignHost {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: Option<String>,
    /// Only Termius carries one, and only in the clear. Never sent to the
    /// frontend: the scan reports how many there are and the import reads
    /// them again itself.
    #[serde(skip)]
    pub password: Option<String>,
    /// The folder the host was in, which becomes its group here.
    pub group: Option<String>,
    /// Labels the other client kept, which stay tags here.
    pub tags: Vec<String>,
    /// Anything worth keeping that has nowhere else to go.
    pub notes: Option<String>,
}

/// What a file turned out to hold.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ForeignScan {
    pub source: Source,
    pub hosts: Vec<ForeignHost>,
    /// Entries recognised and deliberately not offered: an RDP bookmark, a
    /// telnet session, a row with no address. One sentence each, so the dialog
    /// can account for everything in the file rather than appearing to lose
    /// some of it.
    pub skipped: Vec<String>,
}

/// Which client wrote this, or None if nothing here looks like an export.
pub fn sniff(bytes: &[u8]) -> Option<Source> {
    if putty::looks_like(bytes) {
        return Some(Source::Putty);
    }
    let text = decode(bytes);
    if mobaxterm::looks_like(&text) {
        return Some(Source::MobaXterm);
    }
    termius::looks_like(&text).then_some(Source::Termius)
}

/// The hosts in an export, or an error naming what the file is not.
pub fn parse(bytes: &[u8]) -> Result<ForeignScan> {
    match sniff(bytes) {
        Some(Source::Putty) => putty::parse(bytes),
        Some(Source::MobaXterm) => Ok(mobaxterm::parse(&decode(bytes))),
        Some(Source::Termius) => termius::parse(&decode(bytes)),
        None => Err(anyhow!(
            "This is not an export from Termius, PuTTY or MobaXterm. Termius \
             writes a .csv, PuTTY a .reg, MobaXterm a .mxtsessions."
        )),
    }
}

/// Whether a file is one session out of a PuTTY sessions directory, as
/// opposed to an export holding all of them.
///
/// The caller asks because the answer decides whether it reads the file or the
/// directory around it: on Unix, PuTTY writes one file per session and the
/// session's name is the file's name, so a single file read on its own can
/// only be named after the address it points at.
pub fn is_one_putty_session(bytes: &[u8]) -> bool {
    putty::is_lone_session(bytes)
}

/// A whole PuTTY sessions directory, each entry a file name and its contents.
///
/// Takes what the caller has already read rather than a path, so the reading
/// of a directory stays in the command layer and this stays testable from a
/// list.
pub fn parse_putty_dir(files: &[(String, Vec<u8>)]) -> ForeignScan {
    let mut hosts = Vec::new();
    let mut skipped = Vec::new();
    for (name, bytes) in files {
        match putty::parse_session(&decode(bytes), Some(name)) {
            Ok(host) => hosts.push(host),
            Err(why) => skipped.push(why),
        }
    }
    ForeignScan { source: Source::Putty, hosts, skipped }
}

/// The file as text, whatever its encoding.
///
/// UTF-8 where it is valid, and otherwise Windows-1252, which is what a file
/// written on Windows is most likely to be. Decoding cannot fail: every byte
/// has a character in that encoding, so a name with an accent in it arrives as
/// a name rather than as an error.
fn decode(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(text) => text.trim_start_matches('\u{feff}').to_string(),
        Err(_) => bytes.iter().map(|&b| cp1252_char(b)).collect(),
    }
}

/// The one range where Windows-1252 and Latin-1 disagree; elsewhere the byte
/// is the code point.
fn cp1252_char(b: u8) -> char {
    const HIGH: [char; 32] = [
        '\u{20ac}', '\u{81}', '\u{201a}', '\u{192}', '\u{201e}', '\u{2026}', '\u{2020}',
        '\u{2021}', '\u{2c6}', '\u{2030}', '\u{160}', '\u{2039}', '\u{152}', '\u{8d}',
        '\u{17d}', '\u{8f}', '\u{90}', '\u{2018}', '\u{2019}', '\u{201c}', '\u{201d}',
        '\u{2022}', '\u{2013}', '\u{2014}', '\u{2dc}', '\u{2122}', '\u{161}', '\u{203a}',
        '\u{153}', '\u{9d}', '\u{17e}', '\u{178}',
    ];
    match b {
        0x80..=0x9f => HIGH[(b - 0x80) as usize],
        _ => b as char,
    }
}

/// A port as another client wrote it: absent, blank or unreadable all mean the
/// usual one, since a host with a junk port is still a host worth importing.
pub(super) fn port_or_default(raw: &str) -> u16 {
    raw.trim().parse().unwrap_or(22)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_file_from_no_known_client_is_refused_by_name() {
        let e = parse(b"just some text\nwith lines\n").unwrap_err().to_string();
        assert!(e.contains("Termius"), "{e}");
        assert!(e.contains(".mxtsessions"), "{e}");
    }

    #[test]
    fn each_format_is_recognised_from_its_own_contents() {
        assert_eq!(
            sniff(b"Groups,Label,Address,Port,Username\nProd,web,10.0.0.1,22,root\n"),
            Some(Source::Termius)
        );
        assert_eq!(
            sniff(br#"[HKEY_CURRENT_USER\Software\SimonTatham\PuTTY\Sessions\web]
"HostName"="10.0.0.1"
"#),
            Some(Source::Putty)
        );
        assert_eq!(
            sniff(b"[Bookmarks]\nSubRep=\nImgNum=42\nweb=#109#0%10.0.0.1%22%root%%"),
            Some(Source::MobaXterm)
        );
        assert_eq!(sniff(b""), None);
    }

    /// High bytes are a name in a code page, not a reason to fail.
    #[test]
    fn a_file_that_is_not_utf8_is_read_as_windows_1252() {
        assert_eq!(decode(&[b'c', b'a', b'f', 0xe9]), "café");
        assert_eq!(decode(&[0x93, b'x', 0x94]), "\u{201c}x\u{201d}");
    }

    #[test]
    fn a_port_nobody_wrote_is_the_usual_one() {
        assert_eq!(port_or_default("2222"), 2222);
        assert_eq!(port_or_default(" 22 "), 22);
        assert_eq!(port_or_default(""), 22);
        assert_eq!(port_or_default("ssh"), 22);
    }
}
