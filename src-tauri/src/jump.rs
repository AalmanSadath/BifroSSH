//! ProxyJump: reaching a server through one or more bastion hosts.
//!
//! Each hop is a full SSH connection in its own right -- its own host key
//! verification, its own credentials -- and the next hop is carried inside a
//! `direct-tcpip` channel opened on the previous one. The target server sees
//! an ordinary connection arriving from the last jump host, and never learns
//! that a chain was involved.

use std::net::SocketAddr;
use std::sync::Arc;

use anyhow::{anyhow, Result};
use russh::client::{self, Msg};
use russh::Channel;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpStream;
use tokio::time::Duration;

use crate::connect::ConnectSecurity;
use crate::hostverify::{HostKeyVerifier, VerifyingHandler};
use crate::ssh::{AuthContext, SshAuth};

/// OpenSSH puts no limit on chain length, but every hop is a full handshake
/// and possibly a host key prompt. A chain longer than this is a loop in the
/// jump host settings far more often than it is deliberate.
pub const MAX_HOPS: usize = 8;

/// One jump host, already resolved to a set of credentials.
///
/// Hops are ordered outermost first: hop 0 is reached over TCP, and every
/// later hop is reached through the one before it.
pub struct JumpHop {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth: SshAuth,
}

/// Everything `client::connect_stream` needs of a transport.
pub trait Transport: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> Transport for T {}

/// Boxed so that a plain TCP socket and a channel tunnelled through N jump
/// hosts have one type, and the connect paths do not need to branch.
pub type BoxedTransport = Box<dyn Transport + 'static>;

/// Split out of `open_transport` so that the failure message, which is the
/// part a user actually reads, can be tested without a Tauri AppHandle.
async fn resolve_addr(host: &str, port: u16) -> Result<SocketAddr> {
    tokio::net::lookup_host(format!("{}:{}", host, port))
        .await
        .map_err(|e| anyhow!("Cannot resolve host {}: {}", host, e))?
        .next()
        .ok_or_else(|| anyhow!("Cannot resolve host: {}", host))
}

/// Rejects a chain that is almost certainly a loop rather than a real one.
fn check_chain(hops: &[JumpHop]) -> Result<()> {
    if hops.len() > MAX_HOPS {
        return Err(anyhow!(
            "Jump host chain is {} hops long and the limit is {}. Check the jump host settings for a loop.",
            hops.len(),
            MAX_HOPS
        ));
    }
    Ok(())
}

/// Where the hop at `index` has to connect to: the next jump host, or the
/// target itself if this is the last hop.
fn dial_target<'a>(
    hops: &'a [JumpHop],
    index: usize,
    target_host: &'a str,
    target_port: u16,
) -> (&'a str, u16) {
    match hops.get(index + 1) {
        Some(next) => (next.host.as_str(), next.port),
        None => (target_host, target_port),
    }
}

async fn tcp_transport(host: &str, port: u16, sec: &ConnectSecurity) -> Result<TcpStream> {
    sec.log("network", &format!("Starting address resolution of \"{}\"", host));
    let addr = resolve_addr(host, port).await?;
    sec.log("network", "Address resolution finished");

    sec.log("network", &format!("Connecting to \"{}\" port \"{}\"", host, port));
    let stream = TcpStream::connect(addr).await?;
    sec.log("network", "TCP connection established");
    Ok(stream)
}

/// Open a transport to `target_host:target_port`, going through `hops` first.
///
/// With no hops this is a plain TCP connection, so every caller can use it
/// unconditionally. The returned stream is handed to `client::connect_stream`,
/// which then performs the target's own handshake and host key check on top.
pub async fn open_transport(
    hops: &[JumpHop],
    target_host: &str,
    target_port: u16,
    sec: &ConnectSecurity,
    keepalive: Option<Duration>,
) -> Result<BoxedTransport> {
    check_chain(hops)?;

    let Some(first) = hops.first() else {
        return Ok(Box::new(tcp_transport(target_host, target_port, sec).await?));
    };

    let mut stream: BoxedTransport = Box::new(tcp_transport(&first.host, first.port, sec).await?);

    for (index, hop) in hops.iter().enumerate() {
        let (next_host, next_port) = dial_target(hops, index, target_host, target_port);

        sec.log(
            "network",
            &format!("Jumping through \"{}\" port \"{}\"", hop.host, hop.port),
        );

        let config = Arc::new(client::Config {
            keepalive_interval: keepalive,
            ..Default::default()
        });

        let verifier =
            HostKeyVerifier::new(sec.clone(), &hop.host, hop.port, Some(hop.username.clone()))
                .into_jump();
        let mut handle =
            crate::ssh::connect_verified(config, stream, verifier, |v| VerifyingHandler { v })
                .await?;

        let ctx = AuthContext::new(sec.clone(), &hop.username).with_host(&hop.host);
        crate::ssh::authenticate(&mut handle, &hop.auth, &ctx)
            .await
            .map_err(|e| anyhow!("Jump host {}: {}", hop.host, e))?;
        sec.log("auth", &format!("Authenticated to jump host \"{}\"", hop.host));

        let channel: Channel<Msg> = handle
            .channel_open_direct_tcpip(next_host, next_port as u32, "127.0.0.1", 0)
            .await
            .map_err(|e| {
                anyhow!(
                    "Jump host {} could not open a connection to {}:{}: {}",
                    hop.host,
                    next_host,
                    next_port,
                    e
                )
            })?;

        // Dropping the Handle here is deliberate. russh's `Drop` is a no-op
        // and the channel carries its own clone of the sender to the session
        // task, so this hop stays up as long as anything is still reading
        // from the channel -- which, transitively, is the rest of the chain.
        drop(handle);
        stream = Box::new(channel.into_stream());
    }

    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hop(host: &str, port: u16) -> JumpHop {
        JumpHop {
            host: host.to_string(),
            port,
            username: "user".to_string(),
            auth: SshAuth::Password(String::new()),
        }
    }

    fn chain(len: usize) -> Vec<JumpHop> {
        (0..len).map(|i| hop(&format!("hop{}", i), 2200 + i as u16)).collect()
    }

    #[test]
    fn a_chain_within_the_limit_is_accepted() {
        assert!(check_chain(&[]).is_ok());
        assert!(check_chain(&chain(1)).is_ok());
        assert!(check_chain(&chain(MAX_HOPS)).is_ok());
    }

    #[test]
    fn a_chain_past_the_limit_is_rejected_as_a_probable_loop() {
        let err = check_chain(&chain(MAX_HOPS + 1)).unwrap_err().to_string();
        assert!(err.contains(&format!("{} hops long", MAX_HOPS + 1)), "{}", err);
        assert!(err.contains("loop"), "{}", err);
    }

    #[test]
    fn every_hop_but_the_last_dials_the_hop_after_it() {
        let hops = chain(3);
        assert_eq!(dial_target(&hops, 0, "target", 22), ("hop1", 2201));
        assert_eq!(dial_target(&hops, 1, "target", 22), ("hop2", 2202));
    }

    #[test]
    fn the_last_hop_dials_the_target() {
        let hops = chain(3);
        assert_eq!(dial_target(&hops, 2, "target", 2022), ("target", 2022));
        // A single hop is both first and last.
        assert_eq!(dial_target(&chain(1), 0, "target", 2022), ("target", 2022));
    }

    #[tokio::test]
    async fn a_resolvable_host_gives_back_the_port_it_was_asked_for() {
        let addr = resolve_addr("127.0.0.1", 2222).await.unwrap();
        assert_eq!(addr.port(), 2222);
    }

    #[tokio::test]
    async fn an_unresolvable_host_is_named_in_the_error() {
        let err = resolve_addr("no-such-host.invalid", 22)
            .await
            .unwrap_err()
            .to_string();
        assert!(err.contains("no-such-host.invalid"), "{}", err);
    }
}
