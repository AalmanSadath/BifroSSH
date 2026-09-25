//! Termius, which exports a CSV.
//!
//! The columns Termius documents for its own import are Groups, Label, Tags,
//! Address, Protocol, Port, Username and Password, and the exporters people
//! use disagree on the order and on what some of them are called. So the
//! header is read by name, case-insensitively, with the alternatives each
//! column goes by, and a column that is not there is simply absent.

use anyhow::{anyhow, Result};

use super::{port_or_default, ForeignHost, ForeignScan, Source};

/// A CSV whose header names an address and at least one other thing a host
/// has. An address column alone could be any list of machines; an address
/// beside a name, a group or a user is a list of hosts to connect to.
pub(super) fn looks_like(text: &str) -> bool {
    let Some(first) = super::csvfile::rows(text).into_iter().next() else {
        return false;
    };
    let names: Vec<String> = first.iter().map(|f| f.trim().to_lowercase()).collect();
    let has = |wanted: &[&str]| names.iter().any(|n| wanted.contains(&n.as_str()));
    has(ADDRESS) && (has(LABEL) || has(GROUP) || has(USERNAME) || has(PORT))
}

const GROUP: &[&str] = &["groups", "group", "folder", "folders"];
const LABEL: &[&str] = &["label", "name", "alias", "title"];
const ADDRESS: &[&str] = &["address", "hostname", "host", "ip", "ip address"];
const PORT: &[&str] = &["port"];
const USERNAME: &[&str] = &["username", "user", "login"];
const PASSWORD: &[&str] = &["password", "pass"];
const TAGS: &[&str] = &["tags", "tag"];
const PROTOCOL: &[&str] = &["protocol"];

pub(super) fn parse(text: &str) -> Result<ForeignScan> {
    let mut rows = super::csvfile::rows(text).into_iter();
    let header: Vec<String> = rows
        .next()
        .ok_or_else(|| anyhow!("The file is empty."))?
        .iter()
        .map(|f| f.trim().to_lowercase())
        .collect();
    let at = |wanted: &[&str]| header.iter().position(|n| wanted.contains(&n.as_str()));
    let (group, label, address) = (at(GROUP), at(LABEL), at(ADDRESS));
    let (port, username, password) = (at(PORT), at(USERNAME), at(PASSWORD));
    let (tags, protocol) = (at(TAGS), at(PROTOCOL));
    let address = Some(address.ok_or_else(|| {
        anyhow!("This CSV has no address column, so there is nothing in it to connect to.")
    })?);

    let mut hosts = Vec::new();
    let mut skipped = Vec::new();
    for row in rows {
        let field = |i: Option<usize>| {
            i.and_then(|i| row.get(i))
                .map(|f| f.trim())
                .filter(|f| !f.is_empty())
        };
        // A row for something else in the same file, which Termius exports
        // alongside its hosts. Named rather than dropped, so the count in the
        // dialog accounts for every row in the file.
        if let Some(kind) = field(protocol).filter(|p| !p.eq_ignore_ascii_case("ssh")) {
            skipped.push(format!(
                "{} is {kind}, not ssh",
                field(label).or(field(address)).unwrap_or("A row")
            ));
            continue;
        }
        let Some(host) = field(address) else {
            skipped.push(format!(
                "{} has no address",
                field(label).unwrap_or("A row")
            ));
            continue;
        };
        hosts.push(ForeignHost {
            name: field(label).unwrap_or(host).to_string(),
            host: host.to_string(),
            port: field(port).map(port_or_default).unwrap_or(22),
            username: field(username).map(str::to_string),
            password: field(password).map(str::to_string),
            group: field(group).map(str::to_string),
            notes: field(tags).map(|t| format!("Tags: {t}")),
        });
    }
    Ok(ForeignScan { source: Source::Termius, hosts, skipped })
}

#[cfg(test)]
mod tests {
    use super::*;

    const HEADER: &str = "Groups,Label,Tags,Address,Protocol,Port,Username,Password";

    fn parsed(text: &str) -> ForeignScan {
        parse(text).expect("a csv with an address column reads")
    }

    #[test]
    fn the_documented_header_reads_every_column() {
        let scan = parsed(&format!(
            "{HEADER}\nProd,web-1,\"eu,live\",10.0.0.1,ssh,2222,deploy,hunter2\n"
        ));
        assert_eq!(scan.hosts.len(), 1);
        let h = &scan.hosts[0];
        assert_eq!(h.name, "web-1");
        assert_eq!(h.host, "10.0.0.1");
        assert_eq!(h.port, 2222);
        assert_eq!(h.username.as_deref(), Some("deploy"));
        assert_eq!(h.password.as_deref(), Some("hunter2"));
        assert_eq!(h.group.as_deref(), Some("Prod"));
        assert_eq!(h.notes.as_deref(), Some("Tags: eu,live"));
    }

    /// The exporters in the wild disagree on order and on names, and a column
    /// the file does not have is not a failure.
    #[test]
    fn a_reordered_header_with_other_names_reads_the_same() {
        let scan = parsed("Host,User,Name\n10.0.0.2,root,db\n");
        let h = &scan.hosts[0];
        assert_eq!((h.name.as_str(), h.host.as_str()), ("db", "10.0.0.2"));
        assert_eq!(h.username.as_deref(), Some("root"));
        assert_eq!(h.port, 22);
        assert_eq!(h.password, None);
        assert_eq!(h.group, None);
    }

    #[test]
    fn a_group_holding_a_comma_survives_its_quotes() {
        let scan = parsed(&format!("{HEADER}\n\"Prod, EU\",web,,10.0.0.1,ssh,22,root,\n"));
        assert_eq!(scan.hosts[0].group.as_deref(), Some("Prod, EU"));
    }

    #[test]
    fn a_row_for_another_protocol_is_named_rather_than_dropped() {
        let scan = parsed(&format!(
            "{HEADER}\nProd,web,,10.0.0.1,ssh,22,root,\nProd,jump,,10.0.0.9,telnet,23,root,\n"
        ));
        assert_eq!(scan.hosts.len(), 1);
        assert_eq!(scan.skipped, vec!["jump is telnet, not ssh"]);
    }

    #[test]
    fn a_row_with_no_address_is_named_too() {
        let scan = parsed(&format!("{HEADER}\nProd,web,,,ssh,22,root,\n"));
        assert!(scan.hosts.is_empty());
        assert_eq!(scan.skipped, vec!["web has no address"]);
    }

    /// A host nobody named is still a host; its address is the best name there
    /// is for it.
    #[test]
    fn a_row_with_no_label_is_named_for_its_address() {
        let scan = parsed("Group,Address\n,10.0.0.3\n");
        assert_eq!(scan.hosts[0].name, "10.0.0.3");
    }

    #[test]
    fn a_junk_port_does_not_cost_the_host() {
        let scan = parsed("Label,Address,Port\nweb,10.0.0.1,ssh\n");
        assert_eq!(scan.hosts[0].port, 22);
    }

    #[test]
    fn a_header_on_its_own_reads_as_no_hosts_rather_than_an_error() {
        let scan = parsed(HEADER);
        assert!(scan.hosts.is_empty());
        assert!(scan.skipped.is_empty());
    }

    #[test]
    fn a_csv_with_nothing_to_connect_to_says_so() {
        let e = parse("Label,Tags\nweb,eu\n").unwrap_err().to_string();
        assert!(e.contains("no address column"), "{e}");
        assert!(parse("").unwrap_err().to_string().contains("empty"));
    }

    #[test]
    fn a_spreadsheet_that_is_not_an_export_is_not_taken_for_one() {
        assert!(looks_like("Groups,Label,Address\nProd,web,10.0.0.1"));
        assert!(looks_like("host,user\n10.0.0.1,root"));
        assert!(!looks_like("date,amount,payee\n2026-01-01,4.20,cafe"));
        assert!(!looks_like(""));
    }
}
