//! ssh-agent forwarding: the remote shell talks to the local agent.
//!
//! ssh's `-A`. The session asks with `auth-agent-req@openssh.com`, and from
//! then on the remote opens an `auth-agent@openssh.com` channel every time a
//! program there wants the agent. russh hands the handler that channel and
//! the choice to accept it; an accepted one is served by a task of its own
//! for as long as the remote keeps it open.
//!
//! The agent protocol is one length-prefixed request and one length-prefixed
//! reply, in turn. A request is buffered until a whole frame is in hand,
//! written to the agent, and the one reply read back and sent. Frames are
//! checked for size both ways, since the remote is not trusted to be
//! speaking the protocol.
//!
//! Off unless the host asked for it. A channel the remote opens on a
//! connection that did not ask is refused: a bastion, or a jump hop, does
//! not get the agent because it wants it.

use std::time::Duration;

use anyhow::Result;
use russh::client::{ChannelOpenHandle, Msg};
use russh::{Channel, ChannelMsg, ChannelOpenFailure};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::connect::ConnectSecurity;
use crate::ssh::AgentStream;

/// A hardware key waiting for a touch is the slow case this has to allow.
const REPLY_TIMEOUT: Duration = Duration::from_secs(30);

/// Larger than any agent message there is. A remote claiming more is not
/// speaking the protocol, and is not given a buffer that size to fill.
const MAX_FRAME: usize = 256 * 1024;

pub struct AgentForwarding {
    allowed: bool,
    /// Where to say what happened, when there is somewhere.
    sec: Option<ConnectSecurity>,
}

impl Default for AgentForwarding {
    fn default() -> Self {
        Self::disallowed()
    }
}

impl AgentForwarding {
    /// Any agent channel the remote opens is refused.
    pub fn disallowed() -> Self {
        AgentForwarding { allowed: false, sec: None }
    }

    /// Agent channels are answered from the local agent.
    pub fn allowed(sec: ConnectSecurity) -> Self {
        AgentForwarding { allowed: true, sec: Some(sec) }
    }

    /// The remote asked to open an agent channel.
    pub async fn open(&self, channel: Channel<Msg>, reply: ChannelOpenHandle) {
        if !self.allowed {
            // Not asked for, so not answered. Refused rather than ignored:
            // an ignored channel leaves the program on the far side waiting.
            reply.reject(ChannelOpenFailure::AdministrativelyProhibited).await;
            return;
        }
        match crate::ssh::agent_stream().await {
            Ok(stream) => {
                reply.accept().await;
                tokio::spawn(serve(channel, stream, self.sec.clone()));
            }
            Err(e) => {
                log(&self.sec, "error", &format!("Agent forwarding: {e:#}"));
                reply.reject(ChannelOpenFailure::ConnectFailed).await;
            }
        }
    }
}

fn log(sec: &Option<ConnectSecurity>, kind: &str, message: &str) {
    if let Some(sec) = sec {
        sec.log(kind, message);
    }
}

/// Relays one agent channel until the remote closes it, or it stops
/// speaking the protocol.
async fn serve(mut channel: Channel<Msg>, mut stream: AgentStream, sec: Option<ConnectSecurity>) {
    let mut pending = Vec::new();
    while let Some(msg) = channel.wait().await {
        let ChannelMsg::Data { data } = msg else {
            if matches!(msg, ChannelMsg::Eof | ChannelMsg::Close) {
                break;
            }
            continue;
        };
        pending.extend_from_slice(&data);
        loop {
            let frame = match take_frame(&mut pending) {
                Ok(Some(frame)) => frame,
                Ok(None) => break,
                Err(e) => {
                    log(&sec, "error", &format!("Agent forwarding: {e}"));
                    let _ = channel.close().await;
                    return;
                }
            };
            let sent = match exchange(&mut stream, &frame).await {
                Ok(reply) => channel.data_bytes(reply).await.map_err(anyhow::Error::from),
                Err(e) => Err(e),
            };
            if let Err(e) = sent {
                log(&sec, "error", &format!("Agent forwarding: {e:#}"));
                let _ = channel.close().await;
                return;
            }
        }
    }
}

/// One request to the agent and its one reply, framed as the protocol
/// frames them: a big-endian length, then that many bytes.
async fn exchange(stream: &mut AgentStream, request: &[u8]) -> Result<Vec<u8>> {
    let mut framed = Vec::with_capacity(4 + request.len());
    framed.extend_from_slice(&(request.len() as u32).to_be_bytes());
    framed.extend_from_slice(request);
    stream.write_all(&framed).await?;

    tokio::time::timeout(REPLY_TIMEOUT, read_frame(stream))
        .await
        .map_err(|_| anyhow::anyhow!("the agent did not answer within {} seconds", REPLY_TIMEOUT.as_secs()))?
}

/// One frame from the agent, with the length prefix put back on so it can
/// be sent to the remote as it came.
async fn read_frame(stream: &mut AgentStream) -> Result<Vec<u8>> {
    let mut len = [0u8; 4];
    stream.read_exact(&mut len).await?;
    let n = u32::from_be_bytes(len) as usize;
    if n > MAX_FRAME {
        anyhow::bail!("the agent sent a {n} byte reply, which is not a reply");
    }
    let mut out = Vec::with_capacity(4 + n);
    out.extend_from_slice(&len);
    out.resize(4 + n, 0);
    stream.read_exact(&mut out[4..]).await?;
    Ok(out)
}

/// The first whole request in `buf`, without its length prefix, taken out of
/// it. None while the buffer holds only part of one.
fn take_frame(buf: &mut Vec<u8>) -> Result<Option<Vec<u8>>, String> {
    if buf.len() < 4 {
        return Ok(None);
    }
    let n = u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) as usize;
    if n > MAX_FRAME {
        return Err(format!("the remote sent a {n} byte agent request, which is not a request"));
    }
    if buf.len() < 4 + n {
        return Ok(None);
    }
    let frame = buf[4..4 + n].to_vec();
    buf.drain(..4 + n);
    Ok(Some(frame))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn framed(body: &[u8]) -> Vec<u8> {
        let mut v = (body.len() as u32).to_be_bytes().to_vec();
        v.extend_from_slice(body);
        v
    }

    #[test]
    fn a_whole_frame_comes_out_without_its_prefix() {
        let mut buf = framed(b"\x0b");
        assert_eq!(take_frame(&mut buf).unwrap(), Some(b"\x0b".to_vec()));
        assert!(buf.is_empty());
    }

    /// The remote's packets do not line up with agent messages, so a request
    /// can arrive in pieces and two can arrive at once.
    #[test]
    fn a_frame_in_two_halves_waits_for_the_second() {
        let whole = framed(b"hello agent");
        let mut buf = whole[..7].to_vec();
        assert_eq!(take_frame(&mut buf).unwrap(), None);
        buf.extend_from_slice(&whole[7..]);
        assert_eq!(take_frame(&mut buf).unwrap(), Some(b"hello agent".to_vec()));
    }

    #[test]
    fn two_frames_in_one_packet_come_out_in_order() {
        let mut buf = framed(b"one");
        buf.extend(framed(b"two"));
        assert_eq!(take_frame(&mut buf).unwrap(), Some(b"one".to_vec()));
        assert_eq!(take_frame(&mut buf).unwrap(), Some(b"two".to_vec()));
        assert_eq!(take_frame(&mut buf).unwrap(), None);
    }

    /// A length that is not a length is refused before any buffer is grown
    /// to meet it.
    #[test]
    fn an_absurd_length_is_refused() {
        let mut buf = 0xFFFF_FFFFu32.to_be_bytes().to_vec();
        assert!(take_frame(&mut buf).is_err());
    }

    #[test]
    fn fewer_than_four_bytes_is_not_yet_anything() {
        let mut buf = vec![0, 0];
        assert_eq!(take_frame(&mut buf).unwrap(), None);
    }
}
