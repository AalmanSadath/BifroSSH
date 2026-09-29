//! Docker and Podman containers on a host, for the Containers panel.
//!
//! Everything is a shell command over the panel's own SSH connection: one
//! to list, one per start, stop or restart, and a terminal tab for a shell
//! or the logs. Both Docker and Podman are listed where a host has both,
//! which is common: Docker needing a group the user is not in, and rootless
//! Podman beside it. They take the same `ps` template, so one parser reads
//! either.

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{anyhow, bail, Result};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::hostverify::VerifyingHandler;

/// Fields are joined with this. A container name is `[a-zA-Z0-9][a-zA-Z0-9_.-]*`
/// and an image reference cannot hold it either, so it never appears inside
/// a field, and unlike a tab it needs no escape for either engine to print.
const SEP: char = '|';

/// Lists every container, running or not, of each engine the host has.
/// Each part says where it starts, so the parse never guesses; `2>&1` so
/// that why a listing failed comes back with it, and a status line so a
/// failure is told apart from an empty list. A `docker` that is podman-docker
/// is skipped, or every container would be listed twice.
pub const LIST_COMMAND: &str = "for e in docker podman; do \
     command -v $e >/dev/null 2>&1 || continue; \
     if [ $e = docker ] && docker --version 2>/dev/null | grep -qi podman; then continue; fi; \
     echo \"@engine $e\"; \
     $e ps -a --no-trunc --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}|{{.Ports}}' 2>&1; \
     echo \"@status $?\"; \
     done; echo @end";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Engine {
    Docker,
    Podman,
}

impl Engine {
    fn program(self) -> &'static str {
        match self {
            Engine::Docker => "docker",
            Engine::Podman => "podman",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Container {
    pub engine: Engine,
    pub id: String,
    pub name: String,
    pub image: String,
    /// `running`, `exited`, `created`, `paused` and so on, as the engine
    /// says it; the panel only needs to know about `running`.
    pub state: String,
    /// The engine's own words: "Up 3 hours", "Exited (0) 2 days ago".
    pub status: String,
    pub ports: String,
    /// Root's, listed through sudo: acting on it, or opening a tab into it,
    /// runs as root too. Everything else runs as the user.
    pub root: bool,
}

/// An engine that answered, and as whom.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct EngineUse {
    pub engine: Engine,
    pub root: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Listing {
    /// The engines that answered.
    pub engines: Vec<EngineUse>,
    pub containers: Vec<Container>,
    /// Why an engine the host has could not be listed, when another could.
    pub problems: Vec<String>,
}

/// One run of `LIST_COMMAND`, as the user or as root, before the two are
/// put together.
#[derive(Debug, Default)]
pub struct Side {
    engines: Vec<Engine>,
    containers: Vec<Container>,
    problems: Vec<(Engine, String)>,
}

/// Reads what `LIST_COMMAND` printed, as the user alone.
#[cfg(test)]
fn parse_list(out: &str) -> Result<Listing> {
    merge(parse_side(out, false)?, None)
}

/// The user's listing and, with sudo on, root's, as one.
///
/// An error only when nothing could be listed at all: no engine, or every
/// engine failing. One failing beside one that answered is a problem to
/// show next to the containers the other has.
///
/// The user's comes first and wins: a container both can see is shown once,
/// as the user's, so nothing runs as root that does not have to. Docker has
/// one daemon for everyone, so root's Docker adds nothing when the user can
/// reach it; Podman keeps a store per user, so root's is a second set. An
/// engine one side could not reach is no problem when the other listed it.
pub fn merge(user: Side, root: Option<Side>) -> Result<Listing> {
    let root = root.map(|mut side| {
        if user.engines.contains(&Engine::Docker) {
            side.engines.retain(|e| *e != Engine::Docker);
            side.containers.retain(|c| c.engine != Engine::Docker);
            side.problems.retain(|(e, _)| *e != Engine::Docker);
        }
        side
    });
    let root_engines: Vec<Engine> = root.as_ref().map(|r| r.engines.clone()).unwrap_or_default();

    let mut listing = Listing { engines: Vec::new(), containers: Vec::new(), problems: Vec::new() };
    listing.engines.extend(user.engines.iter().map(|&engine| EngineUse { engine, root: false }));
    listing.engines.extend(root_engines.iter().map(|&engine| EngineUse { engine, root: true }));
    listing.problems.extend(
        user.problems.into_iter().filter(|(e, _)| !root_engines.contains(e)).map(|(_, p)| p),
    );
    listing.containers = user.containers;
    if let Some(root) = root {
        listing
            .problems
            .extend(root.problems.into_iter().filter(|(e, _)| !user.engines.contains(e)).map(|(_, p)| p));
        for c in root.containers {
            if !listing.containers.iter().any(|u| u.engine == c.engine && u.id == c.id) {
                listing.containers.push(c);
            }
        }
    }

    if listing.engines.is_empty() {
        if listing.problems.is_empty() {
            bail!("Neither Docker nor Podman is installed on this host.");
        }
        bail!("{}", listing.problems.join("\n"));
    }
    listing
        .containers
        .sort_by(|a, b| (a.state != "running", &a.name).cmp(&(b.state != "running", &b.name)));
    Ok(listing)
}

/// Reads one run of `LIST_COMMAND`. `root` says whose it was.
pub fn parse_side(out: &str, root: bool) -> Result<Side> {
    let mut listing = Side::default();
    let mut current: Option<Engine> = None;
    let mut rows = Vec::new();
    let mut said = Vec::new();
    let mut finished = false;

    for line in out.lines().map(|l| l.trim_end_matches('\r')) {
        if let Some(name) = line.strip_prefix("@engine ") {
            current = match name.trim() {
                "docker" => Some(Engine::Docker),
                "podman" => Some(Engine::Podman),
                _ => None,
            };
            rows.clear();
            said.clear();
        } else if let Some(code) = line.strip_prefix("@status ") {
            let Some(engine) = current.take() else { continue };
            if code.trim() == "0" {
                listing.engines.push(engine);
                listing.containers.append(&mut rows);
            } else {
                listing.problems.push((engine, listing_failure(engine, root, &said.join("\n")).to_string()));
            }
        } else if line == "@end" {
            finished = true;
        } else if let Some(engine) = current {
            match parse_row(engine, root, line) {
                Some(c) => rows.push(c),
                // Anything else the engine said: a notice on success, and
                // the reason on failure.
                None if !line.trim().is_empty() => said.push(line.trim().to_string()),
                None => {}
            }
        }
    }

    if !finished {
        bail!("The host did not finish the container listing.");
    }
    Ok(listing)
}

fn parse_row(engine: Engine, root: bool, line: &str) -> Option<Container> {
    let fields: Vec<&str> = line.split(SEP).collect();
    let [id, name, image, state, status, ports] = fields.as_slice() else { return None };
    if !valid_id(id) {
        return None;
    }
    Some(Container {
        engine,
        id: id.to_string(),
        name: name.to_string(),
        image: image.to_string(),
        state: state.to_lowercase(),
        status: status.to_string(),
        ports: ports.to_string(),
        root,
    })
}

/// The reasons a listing fails that have a fix the user can act on, said as
/// that fix; anything else as the engine put it.
fn listing_failure(engine: Engine, root: bool, said: &str) -> anyhow::Error {
    let who = match (engine, root) {
        (Engine::Docker, false) => "Docker",
        (Engine::Docker, true) => "Docker as root",
        (Engine::Podman, false) => "Podman",
        (Engine::Podman, true) => "Podman as root",
    };
    let lower = said.to_lowercase();
    if !root && lower.contains("permission denied") && (lower.contains("docker.sock") || lower.contains("daemon")) {
        return anyhow!(
            "{who}: this user can't reach it. Use sudo, or add the user to the docker group and log in again."
        );
    }
    if lower.contains("cannot connect to the docker daemon") || lower.contains("is the docker daemon running") {
        return anyhow!("{who}: installed, but not running.");
    }
    let said = if said.is_empty() { "no reason given" } else { said };
    anyhow!("{who}: could not list containers: {said}")
}

/// A container id or name safe to put on a command line as it is: what the
/// engines themselves allow, which has no character a shell treats specially.
pub fn valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
        && id.len() <= 128
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Start,
    Stop,
    Restart,
}

pub fn action_command(engine: Engine, id: &str, action: Action) -> Result<String> {
    check(id)?;
    let verb = match action {
        Action::Start => "start",
        Action::Stop => "stop",
        Action::Restart => "restart",
    };
    Ok(format!("{} {verb} {id}", engine.program()))
}

/// What a terminal tab into a container runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TabKind {
    /// A shell inside it: bash where the image has one, else sh.
    Shell,
    /// Its output, followed.
    Logs,
}

/// The container a terminal tab is for, as the frontend names it.
#[derive(Debug, Clone, Deserialize)]
pub struct TabTarget {
    pub engine: Engine,
    pub id: String,
    pub kind: TabKind,
    /// Run as root, with the sudo the Containers panel holds for the host.
    #[serde(default)]
    pub sudo: bool,
}

/// The command a tab runs in place of the login shell. Built here from a
/// checked id rather than taken as a string from the frontend.
pub fn tab_command(target: &TabTarget) -> Result<String> {
    check(&target.id)?;
    let e = target.engine.program();
    let id = &target.id;
    Ok(match target.kind {
        TabKind::Shell => format!("{e} exec -it {id} sh -c 'command -v bash >/dev/null && exec bash || exec sh'"),
        TabKind::Logs => format!("{e} logs -f --tail 500 {id}"),
    })
}

fn check(id: &str) -> Result<()> {
    if valid_id(id) { Ok(()) } else { bail!("That is not a container id: {id:?}") }
}

/// How sudo is used on a host the user turned it on for.
pub enum Sudo {
    /// `sudo -n` works: the host lets this user in without a password.
    NoPassword,
    /// Given to `sudo -S` on stdin each time. Wiped when dropped.
    Password(zeroize::Zeroizing<String>),
}

impl Sudo {
    /// `command` run as root. With a password, sudo reads it from stdin
    /// (`-S`) and asks for it every time (`-k`), rather than trusting a
    /// ticket something else on the host may have left.
    pub fn wrap(&self, command: &str) -> String {
        let quoted = crate::sftp::remote_exec::quote(command);
        match self {
            Sudo::NoPassword => format!("sudo -n sh -c {quoted}"),
            Sudo::Password(_) => format!("sudo -S -p '' -k sh -c {quoted}"),
        }
    }

    /// What goes to the command's stdin: the password and a newline.
    pub fn input(&self) -> Option<zeroize::Zeroizing<Vec<u8>>> {
        match self {
            Sudo::NoPassword => None,
            Sudo::Password(p) => Some(zeroize::Zeroizing::new(format!("{}\n", p.as_str()).into_bytes())),
        }
    }
}

/// Printed by a sudo tab once terminal echo is off; the session answers it
/// with the password, and takes it out of the output. An OSC sequence, so a
/// terminal that ever saw it would print nothing.
pub const SUDO_MARKER: &[u8] = b"\x1b]7770;bifrossh-sudo\x07";

/// A container tab's command run through sudo. With a password, echo goes
/// off before the marker, so the password the session sends on seeing it is
/// never echoed back onto the screen.
pub fn sudo_tab_command(sudo: &Sudo, command: &str) -> String {
    match sudo {
        Sudo::NoPassword => format!("exec sudo -n {command}"),
        Sudo::Password(_) => {
            format!("stty -echo; printf '\\033]7770;bifrossh-sudo\\007'; exec sudo -S -p '' -k {command}")
        }
    }
}

/// Run to check sudo before holding a password for it.
pub const SUDO_CHECK_NO_PASSWORD: &str = "sudo -n true";
pub const SUDO_CHECK_PASSWORD: &str = "sudo -S -p '' -k true";

/// One connection of the Containers panel.
pub struct Connection {
    pub handle: Arc<russh::client::Handle<VerifyingHandler>>,
    pub server_id: String,
}

/// The Containers panel's connections, by the id handed back when one opens,
/// and sudo for the hosts it was turned on for, by server id.
#[derive(Default)]
pub struct ContainerState {
    pub connections: Mutex<HashMap<String, Connection>>,
    pub sudo: Mutex<HashMap<String, Arc<Sudo>>>,
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "3f4e5d6c7b8a";

    #[test]
    fn a_listing_is_read_running_first() {
        let out = format!(
            "@engine docker\n\
             {ID}|web|nginx:1.27|running|Up 3 hours|0.0.0.0:8080->80/tcp\n\
             aaaa1111|db|postgres:16|exited|Exited (0) 2 days ago|\n\
             @status 0\n\
             @engine podman\n\
             bbbb2222|api|ghcr.io/me/api:latest|running|Up 5 minutes|\n\
             @status 0\n\
             @end\n"
        );
        let listing = parse_list(&out).unwrap();
        let user = |engine| EngineUse { engine, root: false };
        assert_eq!(listing.engines, [user(Engine::Docker), user(Engine::Podman)]);
        assert!(listing.containers.iter().all(|c| !c.root));
        assert!(listing.problems.is_empty());
        let names: Vec<&str> = listing.containers.iter().map(|c| c.name.as_str()).collect();
        assert_eq!(names, ["api", "web", "db"]);
        assert_eq!(listing.containers[0].engine, Engine::Podman);
        let web = &listing.containers[1];
        assert_eq!((web.id.as_str(), web.image.as_str()), (ID, "nginx:1.27"));
        assert_eq!(web.ports, "0.0.0.0:8080->80/tcp");
    }

    /// podman-docker prints a notice on every call; it is not a container
    /// and not a failure.
    #[test]
    fn a_notice_beside_the_listing_is_not_a_row() {
        let out = "@engine podman\nEmulate Docker CLI using podman.\n@status 0\n@end\n";
        let listing = parse_list(out).unwrap();
        assert!(listing.containers.is_empty());
    }

    #[test]
    fn failures_say_what_to_do() {
        let e = parse_list("@end\n").unwrap_err().to_string();
        assert!(e.contains("Neither Docker nor Podman"), "{e}");
        assert!(parse_list("").unwrap_err().to_string().contains("did not finish"));

        let denied = "@engine docker\npermission denied while trying to connect to the docker API at unix:///var/run/docker.sock\n@status 1\n@end\n";
        let e = parse_list(denied).unwrap_err().to_string();
        assert!(e.contains("docker group"), "{e}");

        let down = "@engine docker\nCannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n@status 1\n@end\n";
        assert!(parse_list(down).unwrap_err().to_string().contains("not running"));

        let other = "@engine podman\nError: something odd\n@status 125\n@end\n";
        let e = parse_list(other).unwrap_err().to_string();
        assert!(e.contains("Podman: could not list containers: Error: something odd"), "{e}");
    }

    /// Docker out of reach beside a working Podman: Podman's containers,
    /// and why Docker's are missing.
    #[test]
    fn one_engine_failing_beside_another_is_a_problem_not_an_error() {
        let out = format!(
            "@engine docker\npermission denied while trying to connect to the docker API at unix:///var/run/docker.sock\n@status 1\n\
             @engine podman\n{ID}|web|nginx|running|Up|\n@status 0\n@end\n"
        );
        let listing = parse_list(&out).unwrap();
        assert_eq!(listing.engines, [EngineUse { engine: Engine::Podman, root: false }]);
        assert_eq!(listing.containers.len(), 1);
        assert_eq!(listing.problems.len(), 1);
        assert!(listing.problems[0].contains("docker group"));
    }

    /// With sudo on: the user's rootless Podman stays, root's Docker joins it
    /// marked as root's, and the user's Docker refusal is no longer a
    /// problem now that Docker is listed.
    #[test]
    fn sudo_adds_roots_containers_to_the_users() {
        let user = parse_side(
            "@engine docker\npermission denied while trying to connect to the docker API at unix:///var/run/docker.sock\n@status 1\n\
             @engine podman\naaaa1111|mine|alpine|running|Up|\n@status 0\n@end\n",
            false,
        )
        .unwrap();
        let root = parse_side(
            "@engine docker\nbbbb2222|web|nginx|running|Up|\n@status 0\n@engine podman\n@status 0\n@end\n",
            true,
        )
        .unwrap();
        let listing = merge(user, Some(root)).unwrap();
        assert!(listing.problems.is_empty(), "{:?}", listing.problems);
        let names: Vec<(&str, bool)> = listing.containers.iter().map(|c| (c.name.as_str(), c.root)).collect();
        assert_eq!(names, [("mine", false), ("web", true)]);
        assert_eq!(
            listing.engines,
            [
                EngineUse { engine: Engine::Podman, root: false },
                EngineUse { engine: Engine::Docker, root: true },
                EngineUse { engine: Engine::Podman, root: true },
            ]
        );
    }

    /// Docker has one daemon for everyone: a user who can reach it sees
    /// its containers as their own, and sudo adds no second copy.
    #[test]
    fn docker_the_user_can_reach_is_not_listed_again_as_root() {
        let user = parse_side("@engine docker\nbbbb2222|web|nginx|running|Up|\n@status 0\n@end\n", false).unwrap();
        let root = parse_side("@engine docker\nbbbb2222|web|nginx|running|Up|\n@status 0\n@end\n", true).unwrap();
        let listing = merge(user, Some(root)).unwrap();
        assert_eq!(listing.containers.len(), 1);
        assert!(!listing.containers[0].root);
        assert_eq!(listing.engines, [EngineUse { engine: Engine::Docker, root: false }]);
    }

    #[test]
    fn only_plain_ids_reach_a_command_line() {
        assert!(valid_id(ID));
        assert!(valid_id("my_app.web-1"));
        for bad in ["", "-rm", "a b", "a;rm -rf ~", "$(id)", "a|b", "../x", "'q'"] {
            assert!(!valid_id(bad), "{bad:?}");
        }
        assert!(action_command(Engine::Docker, "x; reboot", Action::Stop).is_err());
    }

    /// The password never appears in a command, only on stdin, and the
    /// command survives the quoting with its own quotes intact.
    #[test]
    fn sudo_wraps_a_command_without_the_password_in_it() {
        let sudo = Sudo::Password(zeroize::Zeroizing::new("hunter2".into()));
        let wrapped = sudo.wrap("docker ps --format '{{.ID}}'");
        assert_eq!(wrapped, r#"sudo -S -p '' -k sh -c 'docker ps --format '\''{{.ID}}'\'''"#);
        assert!(!wrapped.contains("hunter2"));
        assert_eq!(sudo.input().unwrap().as_slice(), b"hunter2\n");
        assert_eq!(Sudo::NoPassword.wrap("true"), "sudo -n sh -c 'true'");
        assert!(Sudo::NoPassword.input().is_none());
    }

    /// A tab turns echo off before it asks for the password, and the marker
    /// it prints is the one the session looks for.
    #[test]
    fn a_sudo_tab_asks_with_echo_off() {
        let sudo = Sudo::Password(zeroize::Zeroizing::new("x".into()));
        let cmd = sudo_tab_command(&sudo, "docker logs -f web");
        assert!(cmd.starts_with("stty -echo; printf '\\033]7770;bifrossh-sudo\\007'"), "{cmd}");
        assert!(cmd.ends_with("exec sudo -S -p '' -k docker logs -f web"), "{cmd}");
        assert_eq!(sudo_tab_command(&Sudo::NoPassword, "docker logs web"), "exec sudo -n docker logs web");
    }

    #[test]
    fn commands_are_built_for_the_engine() {
        assert_eq!(action_command(Engine::Podman, ID, Action::Restart).unwrap(), format!("podman restart {ID}"));
        let shell = TabTarget { engine: Engine::Docker, id: ID.into(), kind: TabKind::Shell, sudo: false };
        assert!(tab_command(&shell).unwrap().starts_with(&format!("docker exec -it {ID} sh -c")));
        let logs = TabTarget { engine: Engine::Podman, id: ID.into(), kind: TabKind::Logs, sudo: false };
        assert_eq!(tab_command(&logs).unwrap(), format!("podman logs -f --tail 500 {ID}"));
    }
}
