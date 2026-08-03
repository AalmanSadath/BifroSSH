//! End-to-end tests for the keyboard-interactive loop, driven by a real
//! russh server over a real TCP socket.
//!
//! A PAM-backed sshd needs root to set up, and the zero-prompt round that Duo
//! and PAM use for "check your phone" cannot be reproduced by hand at all
//! without a live provider. Both are exercised here instead.

use std::borrow::Cow;
use std::sync::Arc;

use async_trait::async_trait;
use russh::client::{self, Prompt};
use russh::server::{self, Auth, Msg, Response, Session};
use russh::{Channel, MethodSet};
use russh_keys::key::{KeyPair, PublicKey};
use tokio::sync::Mutex;

use crate::ssh::{keyboard_interactive, AuthPrompter};

// ── Test server ──────────────────────────────────────────────────────────────

/// One scripted round of the exchange the server will drive.
#[derive(Clone)]
struct Round {
    name: &'static str,
    instructions: &'static str,
    /// Empty means an informational round that expects an immediate empty reply.
    prompts: Vec<(&'static str, bool)>,
    /// Answers that satisfy this round. Empty means anything is accepted.
    expect: Vec<&'static str>,
}

#[derive(Clone)]
struct TestServer {
    rounds: Arc<Vec<Round>>,
    /// Rounds already issued to this client.
    issued: Arc<Mutex<usize>>,
    /// Every set of answers the client sent back.
    received: Arc<Mutex<Vec<Vec<String>>>>,
}

impl server::Server for TestServer {
    type Handler = Self;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        self.clone()
    }
}

#[async_trait]
impl server::Handler for TestServer {
    type Error = russh::Error;

    async fn auth_keyboard_interactive(
        &mut self,
        _user: &str,
        _submethods: &str,
        response: Option<Response<'async_trait>>,
    ) -> Result<Auth, Self::Error> {
        // Record what the client answered for the round just completed.
        if let Some(response) = response {
            let answers: Vec<String> = response
                .map(|b| String::from_utf8_lossy(b).into_owned())
                .collect();

            let index = *self.issued.lock().await;
            if let Some(round) = index.checked_sub(1).and_then(|i| self.rounds.get(i)) {
                if !round.expect.is_empty() && answers != round.expect {
                    return Ok(Auth::Reject { proceed_with_methods: Some(MethodSet::KEYBOARD_INTERACTIVE) });
                }
            }
            self.received.lock().await.push(answers);
        }

        let mut issued = self.issued.lock().await;
        match self.rounds.get(*issued) {
            Some(round) => {
                *issued += 1;
                Ok(Auth::Partial {
                    name: Cow::Borrowed(round.name),
                    instructions: Cow::Borrowed(round.instructions),
                    prompts: Cow::Owned(
                        round
                            .prompts
                            .iter()
                            .map(|(p, echo)| (Cow::Borrowed(*p), *echo))
                            .collect::<Vec<_>>(),
                    ),
                })
            }
            None => Ok(Auth::Accept),
        }
    }

    async fn channel_open_session(
        &mut self,
        _channel: Channel<Msg>,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

/// Boots the scripted server on an ephemeral port. Returns the port plus the
/// record of what the client answered.
async fn spawn_server(rounds: Vec<Round>) -> (u16, Arc<Mutex<Vec<Vec<String>>>>) {
    let received = Arc::new(Mutex::new(Vec::new()));
    let server = TestServer {
        rounds: Arc::new(rounds),
        issued: Arc::new(Mutex::new(0)),
        received: Arc::clone(&received),
    };

    let config = Arc::new(server::Config {
        keys: vec![KeyPair::generate_ed25519().unwrap()],
        methods: MethodSet::KEYBOARD_INTERACTIVE,
        ..Default::default()
    });

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let port = listener.local_addr().unwrap().port();

    tokio::spawn(async move {
        if let Ok((stream, _)) = listener.accept().await {
            let mut server = server.clone();
            let handler = server::Server::new_client(&mut server, None);
            let _ = server::run_stream(config, stream, handler).await;
        }
    });

    (port, received)
}

// ── Test client ──────────────────────────────────────────────────────────────

struct AcceptAnyKey;

#[async_trait]
impl client::Handler for AcceptAnyKey {
    type Error = russh::Error;
    async fn check_server_key(&mut self, _: &PublicKey) -> Result<bool, Self::Error> {
        Ok(true) // host key verification is covered by the hostkeys tests
    }
}

/// Stands in for the user. Records what it was asked and replies from a script.
struct MockPrompter {
    answers: Vec<Vec<String>>,
    /// `true` makes every round come back as a cancellation.
    cancel: bool,
    interactive: bool,
    asked: Mutex<Vec<(String, String, Vec<(String, bool)>)>>,
    calls: Mutex<usize>,
}

impl MockPrompter {
    fn new(answers: Vec<Vec<&str>>) -> Self {
        MockPrompter {
            answers: answers
                .into_iter()
                .map(|a| a.into_iter().map(String::from).collect())
                .collect(),
            cancel: false,
            interactive: true,
            asked: Mutex::new(Vec::new()),
            calls: Mutex::new(0),
        }
    }
}

#[async_trait]
impl AuthPrompter for MockPrompter {
    fn interactive(&self) -> bool {
        self.interactive
    }

    fn log(&self, _kind: &str, _message: &str) {}

    async fn ask(&self, name: &str, instructions: &str, prompts: &[Prompt]) -> Option<Vec<String>> {
        self.asked.lock().await.push((
            name.to_string(),
            instructions.to_string(),
            prompts.iter().map(|p| (p.prompt.clone(), p.echo)).collect(),
        ));
        let mut calls = self.calls.lock().await;
        let index = *calls;
        *calls += 1;

        if self.cancel {
            return None;
        }
        self.answers.get(index).cloned()
    }
}

async fn connect(port: u16) -> client::Handle<AcceptAnyKey> {
    let config = Arc::new(client::Config::default());
    client::connect(config, ("127.0.0.1", port), AcceptAnyKey)
        .await
        .expect("client should connect to the test server")
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[tokio::test]
async fn two_prompt_round_succeeds() {
    let (port, received) = spawn_server(vec![Round {
        name: "PAM authentication",
        instructions: "Enter your credentials",
        prompts: vec![("Password: ", false), ("Verification code: ", true)],
        expect: vec!["hunter2", "123456"],
    }])
    .await;

    let prompter = MockPrompter::new(vec![vec!["hunter2", "123456"]]);
    let mut handle = connect(port).await;

    let ok = keyboard_interactive(&mut handle, "tester", &prompter)
        .await
        .unwrap();

    assert!(ok, "correct answers should authenticate");
    assert_eq!(received.lock().await.as_slice(), &[vec!["hunter2", "123456"]]);

    // The server's wording and echo flags must reach the UI verbatim: a
    // password field rendered with echo on would show the secret.
    let asked = prompter.asked.lock().await;
    assert_eq!(asked.len(), 1);
    assert_eq!(asked[0].0, "PAM authentication");
    assert_eq!(asked[0].1, "Enter your credentials");
    assert_eq!(
        asked[0].2,
        vec![
            ("Password: ".to_string(), false),
            ("Verification code: ".to_string(), true),
        ]
    );
}

/// The case that hangs naive implementations: a round with no prompts is the
/// server talking, not asking, and must be answered immediately without a modal.
#[tokio::test]
async fn zero_prompt_round_answers_without_asking_the_user() {
    let (port, received) = spawn_server(vec![
        Round {
            name: "Duo two-factor",
            instructions: "Pushed a login request to your phone...",
            prompts: vec![],
            expect: vec![],
        },
        Round {
            name: "",
            instructions: "",
            prompts: vec![("Password: ", false)],
            expect: vec!["hunter2"],
        },
    ])
    .await;

    let prompter = MockPrompter::new(vec![vec!["hunter2"]]);
    let mut handle = connect(port).await;

    let ok = keyboard_interactive(&mut handle, "tester", &prompter)
        .await
        .unwrap();

    assert!(ok);
    assert_eq!(
        prompter.asked.lock().await.len(),
        1,
        "the informational round must not raise a prompt"
    );
    let received = received.lock().await;
    assert_eq!(received[0], Vec::<String>::new(), "empty reply sent immediately");
    assert_eq!(received[1], vec!["hunter2"]);
}

#[tokio::test]
async fn cancelling_a_prompt_fails_authentication() {
    let (port, _) = spawn_server(vec![Round {
        name: "PAM",
        instructions: "",
        prompts: vec![("Password: ", false)],
        expect: vec![],
    }])
    .await;

    let mut prompter = MockPrompter::new(vec![]);
    prompter.cancel = true;
    let mut handle = connect(port).await;

    let ok = keyboard_interactive(&mut handle, "tester", &prompter)
        .await
        .unwrap();

    assert!(!ok, "cancelling must not authenticate");
}

/// Background connects (OS detection) have no UI, so they must fail rather
/// than block forever waiting on a prompt nobody can answer.
#[tokio::test]
async fn non_interactive_refuses_to_prompt() {
    let (port, _) = spawn_server(vec![Round {
        name: "PAM",
        instructions: "",
        prompts: vec![("Password: ", false)],
        expect: vec![],
    }])
    .await;

    let mut prompter = MockPrompter::new(vec![vec!["hunter2"]]);
    prompter.interactive = false;
    let mut handle = connect(port).await;

    let ok = keyboard_interactive(&mut handle, "tester", &prompter)
        .await
        .unwrap();

    assert!(!ok);
    assert_eq!(
        prompter.asked.lock().await.len(),
        0,
        "must not prompt when there is no UI"
    );
}

#[tokio::test]
async fn wrong_answer_is_rejected() {
    let (port, _) = spawn_server(vec![Round {
        name: "PAM",
        instructions: "",
        prompts: vec![("Password: ", false)],
        expect: vec!["correct-horse"],
    }])
    .await;

    let prompter = MockPrompter::new(vec![vec!["wrong"]]);
    let mut handle = connect(port).await;

    let ok = keyboard_interactive(&mut handle, "tester", &prompter)
        .await
        .unwrap();

    assert!(!ok, "a wrong answer must not authenticate");
}

/// A server that never stops asking must not loop forever.
#[tokio::test]
async fn endless_prompts_are_capped() {
    let rounds: Vec<Round> = (0..40)
        .map(|_| Round {
            name: "PAM",
            instructions: "",
            prompts: vec![("Again: ", false)],
            expect: vec![],
        })
        .collect();
    let (port, _) = spawn_server(rounds).await;

    let prompter = MockPrompter::new(vec![vec!["x"]; 40]);
    let mut handle = connect(port).await;

    let result = keyboard_interactive(&mut handle, "tester", &prompter).await;

    assert!(result.is_err(), "the loop must give up");
    assert!(
        prompter.asked.lock().await.len() <= 20,
        "must stop at the round cap"
    );
}
