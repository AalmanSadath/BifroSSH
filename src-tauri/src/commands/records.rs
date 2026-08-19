//! Shared handling for the records the app keeps in `AppData`.
//!
//! Servers, identities and keys are all the same shape of thing: a list, a
//! string id, and some fields holding ciphertext that must never leave the
//! backend. Before this the redaction was written out field by field at ten
//! sites and the lookups open coded at nine, which is nine chances to compare
//! the wrong id and ten to forget a newly added secret.

use crate::models::{AppData, Identified, Identity, KeyEntry, PortForwarding, Server};

/// What the frontend sees where a secret is stored.
///
/// It only ever needs to know whether something is set, and it decides that by
/// comparing against this exact string, so the value is part of the contract
/// with `resolveServerAuth` in the frontend store.
pub const STORED: &str = "[stored]";

/// Replaces every stored secret with [`STORED`].
///
/// Implemented per type rather than derived so that adding a secret field to a
/// record is a compile error here until it is handled, rather than a field that
/// silently ships its ciphertext to the webview.
pub trait Redacted {
    fn redacted(self) -> Self;
}

impl Redacted for Server {
    fn redacted(self) -> Self {
        Server {
            encrypted_password: self.encrypted_password.map(|_| STORED.to_string()),
            ..self
        }
    }
}

impl Redacted for Identity {
    fn redacted(self) -> Self {
        Identity {
            encrypted_password: self.encrypted_password.map(|_| STORED.to_string()),
            ..self
        }
    }
}

impl Redacted for KeyEntry {
    fn redacted(self) -> Self {
        KeyEntry {
            encrypted_key: self.encrypted_key.map(|_| STORED.to_string()),
            encrypted_passphrase: self.encrypted_passphrase.map(|_| STORED.to_string()),
            ..self
        }
    }
}

pub fn find_by_id<'a, T: Identified>(items: &'a [T], id: &str) -> Option<&'a T> {
    items.iter().find(|i| i.id() == id)
}

/// Replaces the record with this id, or appends it when there is none.
///
/// Replace rather than merge: the caller has already decided what the whole
/// record should be, including which secrets to carry over from the stored
/// copy.
pub fn upsert_by_id<T: Identified>(items: &mut Vec<T>, item: T) {
    match items.iter().position(|i| i.id() == item.id()) {
        Some(idx) => items[idx] = item,
        None => items.push(item),
    }
}

/// Clears every reference to a record that no longer exists.
///
/// A saved record is pointed at from several places: a server names an
/// identity, a key and a jump host, an identity names a key, and a forwarding
/// names up to two hosts. Deleting one used to leave those pointing at nothing,
/// and the three deletes each decided for themselves what to do about it, so
/// removing an identity tidied up after itself while removing a server or a key
/// did not. A rule left pointing at a deleted host fails at connect time with
/// no way to see why from the list it appears in.
///
/// That this is the wrong outcome is already settled elsewhere: `apply_merge`
/// exists in part to clear exactly these fields when an import cannot resolve
/// them.
///
/// Every field is listed here rather than at the call sites so a new one is
/// added in one place, not three.
pub fn forget_references_to(data: &mut AppData, id: &str) {
    let gone = |field: &mut Option<String>| {
        if field.as_deref() == Some(id) {
            *field = None;
        }
    };

    for server in data.servers.iter_mut() {
        gone(&mut server.identity_id);
        gone(&mut server.key_id);
        gone(&mut server.proxy_jump);
    }
    for identity in data.identities.iter_mut() {
        gone(&mut identity.key_id);
    }
    for pf in data.port_forwardings.iter_mut() {
        gone(&mut pf.intermediate_host_id);
        gone(&mut pf.remote_host_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn server(id: &str, password: Option<&str>) -> Server {
        Server {
            id: id.to_string(),
            name: format!("host {id}"),
            host: "example.com".to_string(),
            port: 22,
            identity_id: None,
            username: Some("root".to_string()),
            encrypted_password: password.map(str::to_string),
            key_id: None,
            theme: None,
            os: String::new(),
            connection_timeout: None,
            auth_kind: None,
            proxy_jump: None,
        }
    }

    /// Deleting a record must leave nothing pointing at it, and all three
    /// deletes must agree about that. They did not: removing an identity
    /// cleared the servers that named it while removing a server or a key
    /// cleared nothing, so a jump chain or a forwarding rule kept an id that
    /// would never resolve again.
    #[test]
    fn deleting_a_record_leaves_nothing_pointing_at_it() {
        let mut data = AppData {
            servers: vec![
                Server { proxy_jump: Some("gone".into()), ..server("via", None) },
                Server {
                    identity_id: Some("gone".into()),
                    key_id: Some("gone".into()),
                    ..server("uses", None)
                },
                // A different id with the same shape must survive untouched,
                // or the helper is clearing by field rather than by id.
                Server { proxy_jump: Some("keep".into()), ..server("other", None) },
            ],
            identities: vec![Identity {
                id: "i1".into(),
                name: "an identity".into(),
                username: "root".into(),
                key_id: Some("gone".into()),
                encrypted_password: None,
                auth_kind: None,
                agent_fingerprint: None,
            }],
            port_forwardings: vec![PortForwarding {
                id: "pf".into(),
                label: "rule".into(),
                kind: "local".into(),
                bind_address: "127.0.0.1".into(),
                local_port: Some(8080),
                intermediate_host_id: Some("gone".into()),
                remote_host_id: Some("gone".into()),
                remote_port: None,
                dest_address: "example.com".into(),
                dest_port: Some(80),
            }],
            ..Default::default()
        };

        forget_references_to(&mut data, "gone");

        assert_eq!(data.servers[0].proxy_jump, None);
        assert_eq!(data.servers[1].identity_id, None);
        assert_eq!(data.servers[1].key_id, None);
        assert_eq!(data.servers[2].proxy_jump.as_deref(), Some("keep"));
        assert_eq!(data.identities[0].key_id, None);
        assert_eq!(data.port_forwardings[0].intermediate_host_id, None);
        assert_eq!(data.port_forwardings[0].remote_host_id, None);
    }

    fn key(id: &str, content: Option<&str>, passphrase: Option<&str>) -> KeyEntry {
        KeyEntry {
            id: id.to_string(),
            name: format!("key {id}"),
            key_path: None,
            encrypted_key: content.map(str::to_string),
            encrypted_passphrase: passphrase.map(str::to_string),
            algorithm: Some("ssh-ed25519".to_string()),
        }
    }

    #[test]
    fn redaction_hides_the_ciphertext_but_keeps_everything_else() {
        let before = server("a", Some("hR8gs0R2Vg=="));
        let after = before.clone().redacted();

        assert_eq!(after.encrypted_password.as_deref(), Some(STORED));
        assert_eq!(after.name, before.name);
        assert_eq!(after.host, before.host);
        assert_eq!(after.username, before.username);
    }

    #[test]
    fn redaction_leaves_an_absent_secret_absent() {
        // The frontend decides whether to offer a password field by whether
        // this is null, so inventing a value here would be a visible bug.
        assert!(server("a", None).redacted().encrypted_password.is_none());
    }

    #[test]
    fn every_secret_on_a_key_is_redacted_not_just_the_first() {
        let after = key("a", Some("pem"), Some("phrase")).redacted();
        assert_eq!(after.encrypted_key.as_deref(), Some(STORED));
        assert_eq!(after.encrypted_passphrase.as_deref(), Some(STORED));
        assert_eq!(after.algorithm.as_deref(), Some("ssh-ed25519"));
    }

    #[test]
    fn redaction_is_idempotent() {
        // list_keys can hand back a record that has already been through here.
        let once = key("a", Some("pem"), Some("phrase")).redacted();
        assert_eq!(once.clone().redacted().encrypted_key, once.encrypted_key);
    }

    #[test]
    fn find_matches_the_whole_id_only() {
        let items = vec![server("abc", None), server("abcd", None)];
        assert_eq!(find_by_id(&items, "abc").unwrap().id, "abc");
        assert_eq!(find_by_id(&items, "abcd").unwrap().id, "abcd");
        assert!(find_by_id(&items, "ab").is_none());
        assert!(find_by_id(&items, "").is_none());
    }

    #[test]
    fn upsert_appends_an_unseen_id() {
        let mut items = vec![server("a", None)];
        upsert_by_id(&mut items, server("b", None));
        assert_eq!(items.len(), 2);
        assert_eq!(items[1].id, "b");
    }

    #[test]
    fn upsert_replaces_in_place_rather_than_appending() {
        let mut items = vec![server("a", None), server("b", None), server("c", None)];
        let mut edited = server("b", Some("secret"));
        edited.name = "renamed".to_string();
        upsert_by_id(&mut items, edited);

        assert_eq!(items.len(), 3);
        // Position matters: the frontend renders the list in stored order, so a
        // rename must not send the host to the bottom.
        assert_eq!(items[1].name, "renamed");
        assert_eq!(items[1].encrypted_password.as_deref(), Some("secret"));
        assert_eq!(items[2].id, "c");
    }

    #[test]
    fn upsert_works_across_record_types() {
        let mut keys = vec![key("a", Some("one"), None)];
        upsert_by_id(&mut keys, key("a", Some("two"), None));
        assert_eq!(keys.len(), 1);
        assert_eq!(keys[0].encrypted_key.as_deref(), Some("two"));
    }
}
