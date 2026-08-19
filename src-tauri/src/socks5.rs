//! The SOCKS5 server side of a dynamic port forward.
//!
//! Only what a client needs to say "connect me to this host": no
//! authentication beyond "none required", and CONNECT only. BIND and UDP
//! ASSOCIATE are refused rather than half implemented.
//!
//! Split out of `tunnel.rs` so it can be driven by a pair of pipes instead of
//! a socket. It is a wire protocol parsing bytes from whoever dialled the
//! port, which is the part of a tunnel most worth testing and was the part
//! that had no tests at all.

use anyhow::{anyhow, Result};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

/// Greets a SOCKS5 client and reads the address it wants, leaving the stream
/// ready to carry traffic.
///
/// Generic over the stream so a test can hand it a pipe. In use it is always a
/// `TcpStream` from the local listener.
pub async fn handshake<S: AsyncRead + AsyncWrite + Unpin>(stream: &mut S) -> Result<(String, u16)> {
    let mut buf = [0u8; 256];

    // Greeting: version, then the methods offered, all of which we ignore
    // because the answer is always "none required".
    stream.read_exact(&mut buf[..2]).await?;
    if buf[0] != 5 {
        return Err(anyhow!("Not SOCKS5"));
    }
    let nmethods = buf[1] as usize;
    if nmethods > 0 {
        stream.read_exact(&mut buf[..nmethods]).await?;
    }
    stream.write_all(&[0x05, 0x00]).await?;

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

    // Succeeded. The bound address we report is all zeroes, which clients
    // ignore for CONNECT.
    stream.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await?;
    Ok((host, port))
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
        let outcome = handshake(&mut server).await;
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
}
