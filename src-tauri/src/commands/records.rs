//! Shared handling for the records the app keeps in `AppData`.
//!
//! Servers, identities and keys are all the same shape of thing: a list, a
//! string id, and some fields holding ciphertext that must never leave the
//! backend. Before this the redaction was written out field by field at ten
//! sites and the lookups open coded at nine, which is nine chances to compare
//! the wrong id and ten to forget a newly added secret.

use crate::models::{Identity, KeyEntry, Server};

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

/// A record addressed by a string id.
pub trait Identified {
    fn id(&self) -> &str;
}

impl Identified for Server {
    fn id(&self) -> &str {
        &self.id
    }
}

impl Identified for Identity {
    fn id(&self) -> &str {
        &self.id
    }
}

impl Identified for KeyEntry {
    fn id(&self) -> &str {
        &self.id
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
