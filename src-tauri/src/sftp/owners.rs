//! Who owns a file, by name.
//!
//! SFTP carries a uid and a gid and nothing else: the protocol's `longname`
//! field is the only place a name travels, and the client library drops it.
//! So the names come from the server's own `/etc/passwd` and `/etc/group`,
//! read once per session over the same SFTP channel and kept until the
//! session closes. A server that will not let them be read, or one without
//! them, shows numbers instead. Locally the C library answers.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use tokio::sync::Mutex;
use russh_sftp::client::SftpSession;

/// Numbers to names and back, for one machine.
#[derive(Default, Debug, PartialEq)]
pub struct IdNames {
    users: HashMap<u32, String>,
    groups: HashMap<u32, String>,
}

/// One side of the pair: a user or a group.
#[derive(Clone, Copy)]
pub enum Which { User, Group }

impl IdNames {
    /// From the text of the two files. Comment lines, short lines and
    /// lines whose id is not a number are skipped rather than fatal, since
    /// one odd line should not blank every owner in the listing.
    pub fn parse(passwd: &str, group: &str) -> Self {
        Self { users: parse_ids(passwd), groups: parse_ids(group) }
    }

    fn table(&self, which: Which) -> &HashMap<u32, String> {
        match which { Which::User => &self.users, Which::Group => &self.groups }
    }

    pub fn name(&self, which: Which, id: u32) -> Option<&str> {
        self.table(which).get(&id).map(String::as_str)
    }

    /// The id behind a name. A number is accepted as itself, so `1000`
    /// works on a server whose passwd could not be read.
    pub fn id(&self, which: Which, name: &str) -> Option<u32> {
        if let Ok(n) = name.parse::<u32>() { return Some(n); }
        self.table(which).iter().find(|(_, n)| n.as_str() == name).map(|(id, _)| *id)
    }

    /// `user:group`, each a name where known and a number where not.
    pub fn owner(&self, uid: Option<u32>, gid: Option<u32>) -> String {
        match (uid, gid) {
            (Some(u), Some(g)) => format!("{}:{}", self.label(Which::User, u), self.label(Which::Group, g)),
            _ => String::new(),
        }
    }

    fn label(&self, which: Which, id: u32) -> String {
        self.name(which, id).map(str::to_owned).unwrap_or_else(|| id.to_string())
    }
}

/// `name:x:id:...` per line, the shape both files share.
fn parse_ids(text: &str) -> HashMap<u32, String> {
    text.lines()
        .filter(|l| !l.starts_with('#'))
        .filter_map(|l| {
            let mut f = l.split(':');
            let name = f.next()?.trim();
            let id = f.nth(1)?.trim().parse::<u32>().ok()?;
            (!name.is_empty()).then(|| (id, name.to_string()))
        })
        // The first line for an id wins, as getpwuid does.
        .fold(HashMap::new(), |mut m, (id, name)| { m.entry(id).or_insert(name); m })
}

/// Names for a session, read now if they have not been.
///
/// A file the server refuses is treated as empty rather than as a failure:
/// a chrooted SFTP user has no `/etc` at all and still wants a listing.
pub(super) async fn remote_names(
    cache: &Mutex<HashMap<String, Arc<IdNames>>>,
    session_id: &str,
    sftp: &SftpSession,
) -> Arc<IdNames> {
    if let Some(names) = cache.lock().await.get(session_id) {
        return Arc::clone(names);
    }
    let passwd = sftp.read("/etc/passwd").await.unwrap_or_default();
    let group = sftp.read("/etc/group").await.unwrap_or_default();
    let names = Arc::new(IdNames::parse(
        &String::from_utf8_lossy(&passwd),
        &String::from_utf8_lossy(&group),
    ));
    cache.lock().await.insert(session_id.to_string(), Arc::clone(&names));
    names
}

/// Resolves a `user` and `group` to numbers through the session's names.
pub fn resolve(names: &IdNames, user: &str, group: &str) -> Result<(u32, u32)> {
    let uid = names.id(Which::User, user.trim())
        .ok_or_else(|| anyhow!("No such user on the server: {user}"))?;
    let gid = names.id(Which::Group, group.trim())
        .ok_or_else(|| anyhow!("No such group on the server: {group}"))?;
    Ok((uid, gid))
}

/// This machine's answer for a uid and gid, as `user:group`.
#[cfg(unix)]
pub fn local_owner(uid: u32, gid: u32) -> String {
    format!(
        "{}:{}",
        local::user_name(uid).unwrap_or_else(|| uid.to_string()),
        local::group_name(gid).unwrap_or_else(|| gid.to_string()),
    )
}

/// The ids behind a local user and group name; a number stands for itself.
#[cfg(unix)]
pub fn local_ids(user: &str, group: &str) -> Result<(u32, u32)> {
    let uid = match user.trim().parse::<u32>() {
        Ok(n) => n,
        Err(_) => local::user_id(user.trim()).ok_or_else(|| anyhow!("No such user: {user}"))?,
    };
    let gid = match group.trim().parse::<u32>() {
        Ok(n) => n,
        Err(_) => local::group_id(group.trim()).ok_or_else(|| anyhow!("No such group: {group}"))?,
    };
    Ok((uid, gid))
}

/// The reentrant getpw*/getgr* calls, wrapped so the rest of the module
/// never sees a raw pointer. Each answers None for an id or name the C
/// library does not know.
#[cfg(unix)]
mod local {
    use std::ffi::{CStr, CString};

    /// Big enough for any sane entry; sysconf suggests 1 KiB on glibc.
    const BUF: usize = 16 * 1024;

    fn c_str(p: *const libc::c_char) -> Option<String> {
        if p.is_null() { return None; }
        // SAFETY: the C library filled the buffer this points into with a
        // NUL-terminated string, and the buffer outlives this call.
        Some(unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned())
    }

    pub fn user_name(uid: u32) -> Option<String> {
        let mut pw: libc::passwd = unsafe { std::mem::zeroed() };
        let mut buf = vec![0u8; BUF];
        let mut out: *mut libc::passwd = std::ptr::null_mut();
        // SAFETY: every pointer is to memory this function owns and that
        // outlives the call; the C library writes within `buf.len()`.
        let rc = unsafe {
            libc::getpwuid_r(uid, &mut pw, buf.as_mut_ptr() as *mut libc::c_char, buf.len(), &mut out)
        };
        if rc != 0 || out.is_null() { return None; }
        c_str(pw.pw_name)
    }

    pub fn group_name(gid: u32) -> Option<String> {
        let mut gr: libc::group = unsafe { std::mem::zeroed() };
        let mut buf = vec![0u8; BUF];
        let mut out: *mut libc::group = std::ptr::null_mut();
        // SAFETY: as in user_name.
        let rc = unsafe {
            libc::getgrgid_r(gid, &mut gr, buf.as_mut_ptr() as *mut libc::c_char, buf.len(), &mut out)
        };
        if rc != 0 || out.is_null() { return None; }
        c_str(gr.gr_name)
    }

    pub fn user_id(name: &str) -> Option<u32> {
        let name = CString::new(name).ok()?;
        let mut pw: libc::passwd = unsafe { std::mem::zeroed() };
        let mut buf = vec![0u8; BUF];
        let mut out: *mut libc::passwd = std::ptr::null_mut();
        // SAFETY: as in user_name; `name` is a valid NUL-terminated string.
        let rc = unsafe {
            libc::getpwnam_r(name.as_ptr(), &mut pw, buf.as_mut_ptr() as *mut libc::c_char, buf.len(), &mut out)
        };
        if rc != 0 || out.is_null() { return None; }
        Some(pw.pw_uid)
    }

    pub fn group_id(name: &str) -> Option<u32> {
        let name = CString::new(name).ok()?;
        let mut gr: libc::group = unsafe { std::mem::zeroed() };
        let mut buf = vec![0u8; BUF];
        let mut out: *mut libc::group = std::ptr::null_mut();
        // SAFETY: as in user_id.
        let rc = unsafe {
            libc::getgrnam_r(name.as_ptr(), &mut gr, buf.as_mut_ptr() as *mut libc::c_char, buf.len(), &mut out)
        };
        if rc != 0 || out.is_null() { return None; }
        Some(gr.gr_gid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASSWD: &str = "\
root:x:0:0:root:/root:/bin/bash
# a comment
daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin
broken line
pi:x:1000:1000:,,,:/home/pi:/bin/bash
alias:x:1000:1000::/home/pi:/bin/sh
noid:x::5::/:/bin/sh
";
    const GROUP: &str = "\
root:x:0:
sudo:x:27:pi
pi:x:1000:
";

    #[test]
    fn the_files_parse_and_odd_lines_are_skipped() {
        let names = IdNames::parse(PASSWD, GROUP);
        assert_eq!(names.name(Which::User, 0), Some("root"));
        assert_eq!(names.name(Which::User, 1000), Some("pi"), "the first line for an id wins");
        assert_eq!(names.name(Which::User, 5), None);
        assert_eq!(names.name(Which::Group, 27), Some("sudo"));
        assert_eq!(names.users.len(), 3);
    }

    #[test]
    fn owners_read_as_names_where_known_and_numbers_where_not() {
        let names = IdNames::parse(PASSWD, GROUP);
        assert_eq!(names.owner(Some(1000), Some(27)), "pi:sudo");
        assert_eq!(names.owner(Some(4242), Some(1000)), "4242:pi");
        assert_eq!(names.owner(None, Some(0)), "", "no uid: nothing to say");
        assert_eq!(IdNames::default().owner(Some(1), Some(2)), "1:2");
    }

    #[test]
    fn a_name_or_a_number_resolves_and_a_stranger_is_refused() {
        let names = IdNames::parse(PASSWD, GROUP);
        assert_eq!(resolve(&names, "pi", "sudo").unwrap(), (1000, 27));
        assert_eq!(resolve(&names, " root ", "0").unwrap(), (0, 0));
        assert_eq!(resolve(&names, "4242", "4243").unwrap(), (4242, 4243));
        let e = resolve(&names, "nobody-here", "pi").unwrap_err();
        assert!(e.to_string().contains("No such user"), "{e}");
        let e = resolve(&names, "pi", "nogroup-here").unwrap_err();
        assert!(e.to_string().contains("No such group"), "{e}");
    }

    #[cfg(unix)]
    #[test]
    fn this_machine_knows_root_and_its_own_user() {
        assert_eq!(local::user_name(0).as_deref(), Some("root"));
        assert_eq!(local::user_id("root"), Some(0));
        assert_eq!(local::user_name(u32::MAX - 1), None);
        assert_eq!(local::user_id("no-such-user-bifrossh"), None);
        // SAFETY: getuid cannot fail.
        let me = unsafe { libc::getuid() };
        let name = local::user_name(me).expect("the running user has a name");
        assert_eq!(local::user_id(&name), Some(me));
        assert_eq!(local_ids(&name, "0").unwrap(), (me, 0));
        assert!(local_owner(me, 0).starts_with(&format!("{name}:")));
    }
}
