use std::time::Instant;

use serde::Serialize;

use super::CmdResult;

/// What one reachability check found.
///
/// A round trip rather than an answer: nothing is authenticated and nothing
/// is sent, so this says only that something accepted a connection on that
/// port, which is what a card can honestly show without credentials.
#[derive(Debug, Clone, Serialize)]
pub struct HostProbe {
    pub reachable: bool,
    /// How long the connect took, milliseconds; 0 when it did not.
    pub ms: u32,
    pub error: Option<String>,
}

/// Opens a TCP connection to the host and closes it again, timing it.
///
/// Deliberately not an SSH handshake: a check the user asked for should not
/// authenticate, should not touch the known hosts file, and should not appear
/// in the server's auth log as a failed login.
#[tauri::command]
pub async fn probe_host(host: String, port: u16, timeout_secs: u32) -> CmdResult<HostProbe> {
    let started = Instant::now();
    let deadline = std::time::Duration::from_secs(timeout_secs.clamp(1, 60) as u64);

    let attempt = tokio::time::timeout(deadline, async {
        let addr = crate::jump::resolve_addr(&host, port).await?;
        tokio::net::TcpStream::connect(addr).await?;
        Ok::<(), anyhow::Error>(())
    })
    .await;

    let elapsed = started.elapsed().as_millis().min(u32::MAX as u128) as u32;
    Ok(match attempt {
        Ok(Ok(())) => HostProbe { reachable: true, ms: elapsed, error: None },
        Ok(Err(e)) => HostProbe { reachable: false, ms: 0, error: Some(e.to_string()) },
        Err(_) => HostProbe {
            reachable: false,
            ms: 0,
            error: Some(format!("No answer within {} seconds.", deadline.as_secs())),
        },
    })
}
