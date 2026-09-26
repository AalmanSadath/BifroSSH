//! MobaXterm, whose sessions are an ini file of packed lines.
//!
//! A `.mxtsessions` file, or the `[Bookmarks*]` sections lifted out of
//! `MobaXterm.ini`. Each section is one folder: `SubRep` is its path with a
//! backslash between levels, `ImgNum` its icon, and every other key is a
//! bookmark whose value is one line of fields:
//!
//! ```text
//! prod-db=#109#0%db.example.com%22%deploy%%-1%-1%%%%%0%...
//! ```
//!
//! After the name: an icon number, then the session type, then a list of
//! fields separated by `%` whose first three, for an SSH session, are the
//! address, the port and the user. Type 0 is SSH; the rest are RDP, telnet,
//! serial and the others MobaXterm also speaks.
//!
//! Only those three fields are read. The rest of the line is dozens of
//! positional flags that MobaXterm does not document and reorders between
//! versions, and a guess at one of them would be silently wrong.

use super::{port_or_default, ForeignHost, ForeignScan, Source};

/// The session type that means SSH.
const SSH: &str = "0";

/// The sections are named for the bookmark folders, which no other ini has.
pub(super) fn looks_like(text: &str) -> bool {
    text.lines().any(|line| {
        let line = line.trim();
        line == "[Bookmarks]" || (line.starts_with("[Bookmarks_") && line.ends_with(']'))
    })
}

pub(super) fn parse(text: &str) -> ForeignScan {
    let mut hosts = Vec::new();
    let mut skipped = Vec::new();
    let mut folder: Option<String> = None;
    let mut in_bookmarks = false;

    for line in text.lines() {
        let line = line.trim_end_matches('\r').trim();
        if let Some(section) = line.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
            in_bookmarks = section == "Bookmarks" || section.starts_with("Bookmarks_");
            folder = None;
            continue;
        }
        if !in_bookmarks || line.is_empty() || line.starts_with(';') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else { continue };
        match key {
            // The folder this section's bookmarks are in. Empty at the root,
            // which MobaXterm shows as "User sessions" and which is no group.
            "SubRep" => folder = folder_path(value),
            "ImgNum" => {}
            name => match bookmark(name, value, folder.as_deref()) {
                Ok(Some(host)) => hosts.push(host),
                Ok(None) => {}
                Err(why) => skipped.push(why),
            },
        }
    }
    ForeignScan { source: Source::MobaXterm, hosts, skipped }
}

/// A bookmark line, or the reason it is not a host. `None` for a line that is
/// not a bookmark at all.
fn bookmark(name: &str, value: &str, folder: Option<&str>) -> Result<Option<ForeignHost>, String> {
    let name = unescape(name);
    // #icon#type%field%field%...
    let mut head = value.trim_start_matches('#').splitn(2, '#');
    let (Some(_icon), Some(rest)) = (head.next(), head.next()) else {
        return Ok(None);
    };
    let mut parts = rest.split('%');
    let Some(kind) = parts.next() else { return Ok(None) };
    if kind.trim() != SSH {
        return Err(format!("{name} is not an ssh session"));
    }
    let fields: Vec<&str> = parts.collect();
    let host = fields.first().map(|h| h.trim()).filter(|h| !h.is_empty());
    let Some(host) = host else {
        return Err(format!("{name} has no address"));
    };
    Ok(Some(ForeignHost {
        name,
        host: unescape(host),
        port: fields.get(1).map(|p| port_or_default(p)).unwrap_or(22),
        // MobaXterm writes <default> for "whoever is logged in here", which is
        // the same thing as not having been told a user.
        username: fields
            .get(2)
            .map(|u| unescape(u.trim()))
            .filter(|u| !u.is_empty() && u != "<default>"),
        password: None,
        group: folder.map(str::to_string),
        tags: Vec::new(),
        notes: None,
    }))
}

/// The folder as a group: `Prod\Databases` reads as `Prod/Databases`, and the
/// root folder, which has no name, is no group.
fn folder_path(raw: &str) -> Option<String> {
    let path = unescape(raw.trim());
    (!path.is_empty()).then(|| path.replace('\\', "/"))
}

/// MobaXterm cannot store these characters in an ini value, so it writes each
/// one as a word.
fn unescape(value: &str) -> String {
    value
        .replace("__DIEZE__", "#")
        .replace("__PTVIRG__", ";")
        .replace("__DBLQUO__", "\"")
        .replace("__PIPE__", "|")
}

#[cfg(test)]
mod tests {
    use super::*;

    const FILE: &str = "[Bookmarks]\r\n\
        SubRep=\r\n\
        ImgNum=42\r\n\
        web=#109#0%10.0.0.1%22%root%%-1%-1%%%%%0%0%0%%%-1%%%%%%\r\n\
        \r\n\
        [Bookmarks_1]\r\n\
        SubRep=Prod\\Databases\r\n\
        ImgNum=41\r\n\
        prod-db=#109#0%db.example.com%2222%deploy%%-1%-1%%%%%0%0%0\r\n\
        desktop=#91#4%10.0.0.7%3389%admin%%-1%-1%%\r\n";

    #[test]
    fn a_root_bookmark_and_a_nested_one_both_read() {
        let scan = parse(FILE);
        assert_eq!(scan.hosts.len(), 2);
        let web = &scan.hosts[0];
        assert_eq!((web.name.as_str(), web.host.as_str(), web.port), ("web", "10.0.0.1", 22));
        assert_eq!(web.username.as_deref(), Some("root"));
        // The root folder has no name, so it is no group.
        assert_eq!(web.group, None);
        let db = &scan.hosts[1];
        assert_eq!(db.group.as_deref(), Some("Prod/Databases"));
        assert_eq!(db.port, 2222);
        assert_eq!(db.username.as_deref(), Some("deploy"));
    }

    /// MobaXterm is an RDP, VNC, telnet and serial client too, and those
    /// bookmarks sit in the same file.
    #[test]
    fn a_bookmark_for_another_protocol_is_named_rather_than_dropped() {
        assert_eq!(parse(FILE).skipped, vec!["desktop is not an ssh session"]);
    }

    #[test]
    fn a_name_that_held_a_hash_gets_it_back() {
        let scan = parse("[Bookmarks]\nSubRep=\nbox__DIEZE__2=#109#0%10.0.0.2%22%root%%");
        assert_eq!(scan.hosts[0].name, "box#2");
    }

    #[test]
    fn a_default_user_is_no_user() {
        let scan = parse("[Bookmarks]\nSubRep=\nweb=#109#0%10.0.0.1%22%<default>%%");
        assert_eq!(scan.hosts[0].username, None);
    }

    #[test]
    fn a_bookmark_with_no_address_is_named_too() {
        let scan = parse("[Bookmarks]\nSubRep=\nweb=#109#0%%22%root%%");
        assert!(scan.hosts.is_empty());
        assert_eq!(scan.skipped, vec!["web has no address"]);
    }

    #[test]
    fn a_missing_port_is_the_usual_one() {
        let scan = parse("[Bookmarks]\nSubRep=\nweb=#109#0%10.0.0.1");
        assert_eq!(scan.hosts[0].port, 22);
    }

    /// The same sections inside the whole MobaXterm.ini, where everything else
    /// in the file is settings rather than hosts.
    #[test]
    fn the_rest_of_the_configuration_file_is_passed_over() {
        let text = "[Misc]\nRefreshRate=60\n[Bookmarks]\nSubRep=\nweb=#109#0%10.0.0.1%22%root%%\n\
                    [Colors]\nBackgroundColour=0,0,0\nweb=not a bookmark\n";
        let scan = parse(text);
        assert_eq!(scan.hosts.len(), 1);
        assert!(scan.skipped.is_empty());
    }

    #[test]
    fn only_a_bookmarks_file_is_taken_for_one() {
        assert!(looks_like(FILE));
        assert!(looks_like("[Bookmarks_12]\nSubRep=X\n"));
        assert!(!looks_like("[Misc]\nRefreshRate=60\n"));
        assert!(!looks_like(""));
    }
}
