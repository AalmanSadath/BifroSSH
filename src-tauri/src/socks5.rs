//! The SOCKS5 server side of a dynamic port forward.
//!
//! Only what a client needs to say "connect me to this host": either no
//! authentication or a username and password (RFC 1929), and CONNECT only.
//! BIND and UDP ASSOCIATE are refused rather than half implemented.
//!
//! Split out of `tunnel.rs` so it can be driven by a pair of pipes instead of
//! a socket. It is a wire protocol parsing bytes from whoever dialled the
//! port, which is the part of a tunnel most worth testing and was the part
//! that had no tests at all.

use anyhow::{anyhow, Result};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// The username and password a client has to give, when the rule sets them.
pub struct Credentials<'a> {
    pub username: &'a str,
    pub password: &'a str,
}

/// Greets a SOCKS5 client and reads the address it wants. The client waits
/// for `reply` to say whether it got there.
///
/// With `auth` set the client has to offer username and password and get
/// them right; a client that offers only "none required" is told no method
/// is acceptable. Without it, whatever the client offers, the answer is
/// "none required", as it always was.
///
/// Generic over the stream so a test can hand it a pipe. In use it is always a
/// `TcpStream` from the local listener.
pub async fn handshake<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    auth: Option<Credentials<'_>>,
) -> Result<(String, u16)> {
    let mut buf = [0u8; 256];

    // Greeting: version, then the methods offered.
    stream.read_exact(&mut buf[..2]).await?;
    if buf[0] != 5 {
        return Err(anyhow!("Not SOCKS5"));
    }
    let nmethods = buf[1] as usize;
    if nmethods > 0 {
        stream.read_exact(&mut buf[..nmethods]).await?;
    }
    match auth {
        None => stream.write_all(&[0x05, 0x00]).await?,
        Some(creds) => {
            if !buf[..nmethods].contains(&0x02) {
                let _ = stream.write_all(&[0x05, 0xFF]).await;
                return Err(anyhow!("Client did not offer username and password"));
            }
            stream.write_all(&[0x05, 0x02]).await?;
            authenticate(stream, creds).await?;
        }
    }

    // Request: version, command, reserved, address type.
    stream.read_exact(&mut buf[..4]).await?;
    if buf[0] != 5 || buf[1] != 1 {
        let _ = stream.write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
        return Err(anyhow!("Only CONNECT supported"));
    }

    let (host, port) = match buf[3] {
        0x01 => {
            stream.read_exact(&mut buf[..6]).await?;
            let ip = format!("{}.{}.{}.{}", buf[0], buf[1], buf[2], buf[3]);
            (ip, u16::from_be_bytes([buf[4], buf[5]]))
        }
        0x03 => {
            stream.read_exact(&mut buf[..1]).await?;
            let len = buf[0] as usize;
            // Read into its own buffer rather than `buf`: a name may be 255
            // bytes and the port follows it, which is 257 and one more than
            // `buf` holds. Slicing it there panicked on the longest name the
            // protocol allows.
            let mut addr = vec![0u8; len + 2];
            stream.read_exact(&mut addr).await?;
            let host = String::from_utf8_lossy(&addr[..len]).to_string();
            (host, u16::from_be_bytes([addr[len], addr[len + 1]]))
        }
        0x04 => {
            stream.read_exact(&mut buf[..18]).await?;
            let segs: Vec<String> = buf[..16]
                .chunks(2)
                .map(|c| format!("{:02x}{:02x}", c[0], c[1]))
                .collect();
            (segs.join(":"), u16::from_be_bytes([buf[16], buf[17]]))
        }
        t => return Err(anyhow!("Unknown addr type {}", t)),
    };

    Ok((host, port))
}

/// The username and password subnegotiation (RFC 1929): version 1, then the
/// two as length-prefixed strings. A wrong pair is answered as a failure and
/// the connection is dropped, which is what the RFC asks for.
async fn authenticate<S: AsyncRead + AsyncWrite + Unpin>(stream: &mut S, creds: Credentials<'_>) -> Result<()> {
    let mut head = [0u8; 2];
    stream.read_exact(&mut head).await?;
    if head[0] != 1 {
        let _ = stream.write_all(&[0x01, 0x01]).await;
        return Err(anyhow!("Unknown authentication version {}", head[0]));
    }
    let mut username = vec![0u8; head[1] as usize];
    stream.read_exact(&mut username).await?;
    let mut len = [0u8; 1];
    stream.read_exact(&mut len).await?;
    let mut password = vec![0u8; len[0] as usize];
    stream.read_exact(&mut password).await?;

    // Both compared in full whatever the first says, so the time taken does
    // not tell a guesser which half was wrong.
    let user_ok = same(&username, creds.username.as_bytes());
    let pass_ok = same(&password, creds.password.as_bytes());
    if !(user_ok & pass_ok) {
        let _ = stream.write_all(&[0x01, 0x01]).await;
        return Err(anyhow!("Wrong SOCKS username or password"));
    }
    stream.write_all(&[0x01, 0x00]).await?;
    Ok(())
}

/// Equality that looks at every byte rather than stopping at the first
/// difference. The length is not hidden; the content is.
fn same(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Tells the client whether its CONNECT went through, once the channel to
/// the target has opened or failed to. Answering before that, as this once
/// did, told every client it had connected, and one whose target could not
/// be reached saw a connection that closed at once instead of an error.
///
/// The bound address is all zeroes, which clients ignore for CONNECT.
pub async fn reply<S: AsyncWrite + Unpin>(stream: &mut S, connected: bool) -> Result<()> {
    // 0x01 is "general failure": the server does not say why a channel was
    // refused in terms SOCKS has a code for.
    let code = if connected { 0x00 } else { 0x01 };
    stream.write_all(&[0x05, code, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::duplex;

    /// Plays a client: writes `request` in one go, runs the handshake against
    /// the other end, and hands back what the server decided and replied.
    async fn talk(request: &[u8]) -> (Result<(String, u16)>, Vec<u8>) {
        let (mut client, mut server) = duplex(2048);
        client.write_all(request).await.unwrap();
        // Close the client's writing half, so a handshake waiting on bytes that
        // are never coming sees the end of the stream instead of hanging. A
        // real client that stops mid-request eventually does the same.
        client.shutdown().await.unwrap();
        let outcome = handshake(&mut server, None).await;
        if outcome.is_ok() {
            reply(&mut server, true).await.unwrap();
        }
        // Dropping the server end lets the client read to EOF instead of
        // blocking on a reply that is never coming.
        drop(server);
        let mut reply = Vec::new();
        client.read_to_end(&mut reply).await.unwrap();
        (outcome, reply)
    }

    /// Greeting offering only "no authentication".
    const HELLO: &[u8] = &[0x05, 0x01, 0x00];
    /// What a server sends back for an accepted greeting, then a granted CONNECT.
    const GREETED_AND_GRANTED: &[u8] = &[0x05, 0x00, 0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0];

    #[tokio::test]
    async fn connect_to_an_ipv4_address() {
        let mut req = HELLO.to_vec();
        req.extend_from_slice(&[0x05, 0x01, 0x00, 0x01, 93, 184, 216, 34, 0x01, 0xbb]);
        let (out, reply) = talk(&req).await;
        assert_eq!(out.unwrap(), ("93.184.216.34".to_string(), 443));
        assert_eq!(reply, GREETED_AND_GRANTED);
    }

    #[tokio::test]
    async fn connect_to_a_domain_name() {
        let host = b"example.com";
        let mut req = HELLO.to_vec();
        req.extend_from_slice(&[0x05, 0x01, 0x00, 0x03, host.len() as u8]);
        req.extend_from_slice(host);
        req.extend_from_slice(&[0x00, 0x50]);
        let (out, reply) = talk(&req).await;
        assert_eq!(out.unwrap(), ("example.com".to_string(), 80));
        assert_eq!(reply, GREETED_AND_GRANTED);
    }

    /// 255 is the longest name the protocol allows, and with the port after it
    /// that is 257 bytes. Reading it into the 256 byte scratch buffer panicked.
    #[tokio::test]
    async fn a_domain_name_of_the_maximum_length_does_not_panic() {
        let host = vec![b'a'; 255];
        let mut req = HELLO.to_vec();
        req.extend_from_slice(&[0x05, 0x01, 0x00, 0x03, 255]);
        req.extend_from_slice(&host);
        req.extend_from_slice(&[0x1f, 0x90]);
        let (out, _) = talk(&req).await;
        let (got_host, port) = out.expect("the longest allowed name was refused");
        assert_eq!(got_host.len(), 255);
        assert_eq!(port, 8080);
    }

    #[tokio::test]
    async fn connect_to_an_ipv6_address() {
        let mut req = HELLO.to_vec();
        req.extend_from_slice(&[0x05, 0x01, 0x00, 0x04]);
        req.extend_from_slice(&[0x20, 0x01, 0x0d, 0xb8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
        req.extend_from_slice(&[0x01, 0xbb]);
        let (out, _) = talk(&req).await;
        assert_eq!(out.unwrap(), ("2001:0db8:0000:0000:0000:0000:0000:0001".to_string(), 443));
    }

    /// A greeting offering several methods: all of them are read and ignored,
    /// and leaving any behind would desynchronise everything after it.
    #[tokio::test]
    async fn a_greeting_offering_several_methods_is_consumed_whole() {
        let mut req = vec![0x05, 0x03, 0x00, 0x01, 0x02];
        req.extend_from_slice(&[0x05, 0x01, 0x00, 0x01, 10, 0, 0, 1, 0x00, 0x16]);
        let (out, _) = talk(&req).await;
        assert_eq!(out.unwrap(), ("10.0.0.1".to_string(), 22));
    }

    #[tokio::test]
    async fn a_greeting_offering_no_methods_still_works() {
        let mut req = vec![0x05, 0x00];
        req.extend_from_slice(&[0x05, 0x01, 0x00, 0x01, 10, 0, 0, 1, 0x00, 0x16]);
        let (out, _) = talk(&req).await;
        assert_eq!(out.unwrap(), ("10.0.0.1".to_string(), 22));
    }

    /// A target the SSH server would not open a channel to is an error the
    /// client is told about, not a connection that closes at once.
    #[tokio::test]
    async fn a_connect_that_failed_is_answered_as_a_failure() {
        let (mut client, mut server) = duplex(64);
        reply(&mut server, false).await.unwrap();
        drop(server);
        let mut got = Vec::new();
        client.read_to_end(&mut got).await.unwrap();
        assert_eq!(got, [0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
    }

    #[tokio::test]
    async fn a_client_speaking_socks4_is_turned_away() {
        let (out, reply) = talk(&[0x04, 0x01, 0x00, 0x16]).await;
        assert!(format!("{:#}", out.unwrap_err()).contains("Not SOCKS5"));
        assert!(reply.is_empty(), "nothing should be sent before the version is known");
    }

    /// BIND and UDP ASSOCIATE are refused, and the client is told so rather
    /// than left waiting.
    #[tokio::test]
    async fn a_command_other_than_connect_is_refused_in_the_protocol() {
        let mut req = HELLO.to_vec();
        req.extend_from_slice(&[0x05, 0x02, 0x00, 0x01, 10, 0, 0, 1, 0x00, 0x16]);
        let (out, reply) = talk(&req).await;
        assert!(format!("{:#}", out.unwrap_err()).contains("CONNECT"));
        // Greeting accepted, then reply 0x07: command not supported.
        assert_eq!(reply, &[0x05, 0x00, 0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
    }

    #[tokio::test]
    async fn an_unknown_address_type_is_named() {
        let mut req = HELLO.to_vec();
        req.extend_from_slice(&[0x05, 0x01, 0x00, 0x09]);
        let (out, _) = talk(&req).await;
        assert!(format!("{:#}", out.unwrap_err()).contains('9'));
    }

    #[tokio::test]
    async fn a_request_that_stops_half_way_is_an_error_not_a_hang() {
        let mut req = HELLO.to_vec();
        req.extend_from_slice(&[0x05, 0x01, 0x00, 0x01, 10, 0]); // two bytes short
        let (out, _) = talk(&req).await;
        assert!(out.is_err());
    }

    /// As `talk`, against a rule that wants a username and password.
    async fn talk_with_auth(request: &[u8]) -> (Result<(String, u16)>, Vec<u8>) {
        let (mut client, mut server) = duplex(2048);
        client.write_all(request).await.unwrap();
        client.shutdown().await.unwrap();
        let creds = Credentials { username: "alice", password: "s3cret" };
        let outcome = handshake(&mut server, Some(creds)).await;
        if outcome.is_ok() {
            reply(&mut server, true).await.unwrap();
        }
        drop(server);
        let mut reply = Vec::new();
        client.read_to_end(&mut reply).await.unwrap();
        (outcome, reply)
    }

    /// Greeting offering username and password, then the subnegotiation.
    fn login(user: &[u8], pass: &[u8]) -> Vec<u8> {
        let mut req = vec![0x05, 0x01, 0x02, 0x01, user.len() as u8];
        req.extend_from_slice(user);
        req.push(pass.len() as u8);
        req.extend_from_slice(pass);
        req
    }

    #[tokio::test]
    async fn the_right_username_and_password_get_through() {
        let mut req = login(b"alice", b"s3cret");
        req.extend_from_slice(&[0x05, 0x01, 0x00, 0x01, 10, 0, 0, 1, 0x00, 0x16]);
        let (out, reply) = talk_with_auth(&req).await;
        assert_eq!(out.unwrap(), ("10.0.0.1".to_string(), 22));
        // Method 0x02 chosen, login accepted, CONNECT granted.
        assert_eq!(reply, &[0x05, 0x02, 0x01, 0x00, 0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
    }

    #[tokio::test]
    async fn a_wrong_password_is_refused_before_any_request() {
        let mut req = login(b"alice", b"s3creT");
        req.extend_from_slice(&[0x05, 0x01, 0x00, 0x01, 10, 0, 0, 1, 0x00, 0x16]);
        let (out, reply) = talk_with_auth(&req).await;
        assert!(format!("{:#}", out.unwrap_err()).contains("username or password"));
        assert_eq!(reply, &[0x05, 0x02, 0x01, 0x01]);
    }

    #[tokio::test]
    async fn a_wrong_username_is_refused() {
        let (out, reply) = talk_with_auth(&login(b"bob", b"s3cret")).await;
        assert!(out.is_err());
        assert_eq!(reply, &[0x05, 0x02, 0x01, 0x01]);
    }

    /// A client that only offers "none required" to a rule that wants a
    /// login is told no method is acceptable, not let in.
    #[tokio::test]
    async fn a_client_without_credentials_is_turned_away_when_they_are_required() {
        let mut req = HELLO.to_vec();
        req.extend_from_slice(&[0x05, 0x01, 0x00, 0x01, 10, 0, 0, 1, 0x00, 0x16]);
        let (out, reply) = talk_with_auth(&req).await;
        assert!(out.is_err());
        assert_eq!(reply, &[0x05, 0xFF]);
    }
}
