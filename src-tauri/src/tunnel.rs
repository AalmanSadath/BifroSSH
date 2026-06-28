use std::collections::HashMap;
use std::sync::Arc;
use anyhow::{anyhow, Result};
use async_trait::async_trait;
use russh::*;
use russh::client::{self, Msg};
use russh_keys::key::KeyPair;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{oneshot, Mutex};

// ── State ─────────────────────────────────────────────────────────────────────

pub struct TunnelHandle {
    pub stop_tx: oneshot::Sender<()>,
}

pub struct TunnelState {
    pub tunnels: Mutex<HashMap<String, TunnelHandle>>,
}

impl TunnelState {
    pub fn new() -> Self {
        Self { tunnels: Mutex::new(HashMap::new()) }
    }
}

// ── Auth / params ─────────────────────────────────────────────────────────────

pub struct TunnelAuth {
    pub kind: String,
    pub value: String,
    pub passphrase: Option<String>,
}

pub enum TunnelKind {
    Local   { local_port: u32, dest_host: String, dest_port: u32 },
    Remote  { remote_port: u32, dest_host: String, dest_port: u32 },
    Dynamic { local_port: u32 },
}

pub struct TunnelParams {
    pub kind: TunnelKind,
    pub bind_address: String,
    pub ssh_host: String,
    pub ssh_port: u16,
    pub ssh_username: String,
    pub auth: TunnelAuth,
}

struct TunnelBase {
    bind_address: String,
    ssh_host: String,
    ssh_port: u16,
    ssh_username: String,
    auth: TunnelAuth,
}

// ── Handlers ──────────────────────────────────────────────────────────────────

struct BasicHandler;

#[async_trait]
impl client::Handler for BasicHandler {
    type Error = russh::Error;
    async fn check_server_key(&mut self, _: &russh_keys::key::PublicKey) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

struct RemoteForwardHandler {
    dest_host: String,
    dest_port: u32,
}

#[async_trait]
impl client::Handler for RemoteForwardHandler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, _: &russh_keys::key::PublicKey) -> Result<bool, Self::Error> {
        Ok(true)
    }

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<Msg>,
        _connected_address: &str,
        _connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let dh = self.dest_host.clone();
        let dp = self.dest_port;
        tokio::spawn(async move {
            if let Ok(stream) = TcpStream::connect(format!("{}:{}", dh, dp)).await {
                proxy_tcp_channel(stream, channel).await;
            }
        });
        Ok(())
    }
}

// ── SSH connect helpers ───────────────────────────────────────────────────────

async fn authenticate_handle<H: client::Handler>(
    handle: &mut client::Handle<H>,
    username: &str,
    auth: &TunnelAuth,
) -> Result<()> {
    let ok = if auth.kind == "password" {
        handle.authenticate_password(username, &auth.value).await?
    } else {
        let kp: KeyPair = russh_keys::decode_secret_key(&auth.value, auth.passphrase.as_deref())?;
        handle.authenticate_publickey(username, Arc::new(kp)).await?
    };
    if !ok { return Err(anyhow!("Authentication failed")); }
    Ok(())
}

async fn connect_basic(base: &TunnelBase) -> Result<client::Handle<BasicHandler>> {
    let config = Arc::new(client::Config::default());
    let addr = tokio::net::lookup_host(format!("{}:{}", base.ssh_host, base.ssh_port))
        .await?
        .next()
        .ok_or_else(|| anyhow!("Cannot resolve {}", base.ssh_host))?;
    let mut handle = client::connect(config, addr, BasicHandler).await?;
    authenticate_handle(&mut handle, &base.ssh_username, &base.auth).await?;
    Ok(handle)
}

async fn connect_remote_fwd(
    base: &TunnelBase,
    dest_host: String,
    dest_port: u32,
) -> Result<client::Handle<RemoteForwardHandler>> {
    let config = Arc::new(client::Config::default());
    let addr = tokio::net::lookup_host(format!("{}:{}", base.ssh_host, base.ssh_port))
        .await?
        .next()
        .ok_or_else(|| anyhow!("Cannot resolve {}", base.ssh_host))?;
    let handler = RemoteForwardHandler { dest_host, dest_port };
    let mut handle = client::connect(config, addr, handler).await?;
    authenticate_handle(&mut handle, &base.ssh_username, &base.auth).await?;
    Ok(handle)
}

// ── Proxy ─────────────────────────────────────────────────────────────────────

async fn proxy_tcp_channel(stream: TcpStream, mut channel: Channel<Msg>) {
    let (mut r, mut w) = stream.into_split();
    let mut buf = vec![0u8; 32768];
    loop {
        tokio::select! {
            n = r.read(&mut buf) => match n {
                Ok(0) | Err(_) => { let _ = channel.eof().await; break; }
                Ok(n) => { if channel.data(&buf[..n]).await.is_err() { break; } }
            },
            msg = channel.wait() => match msg {
                Some(ChannelMsg::Data { ref data }) => {
                    if w.write_all(data.as_ref()).await.is_err() { break; }
                }
                Some(ChannelMsg::Eof) | Some(ChannelMsg::Close) | None => break,
                _ => {}
            },
        }
    }
}

// ── SOCKS5 ────────────────────────────────────────────────────────────────────

async fn socks5_handshake(stream: &mut TcpStream) -> Result<(String, u16)> {
    let mut buf = [0u8; 256];

    stream.read_exact(&mut buf[..2]).await?;
    if buf[0] != 5 { return Err(anyhow!("Not SOCKS5")); }
    let nmethods = buf[1] as usize;
    if nmethods > 0 { stream.read_exact(&mut buf[..nmethods]).await?; }
    stream.write_all(&[0x05, 0x00]).await?;

    stream.read_exact(&mut buf[..4]).await?;
    if buf[0] != 5 || buf[1] != 1 {
        let _ = stream.write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await;
        return Err(anyhow!("Only CONNECT supported"));
    }

    let (host, port) = match buf[3] {
        0x01 => {
            stream.read_exact(&mut buf[..6]).await?;
            let ip = format!("{}.{}.{}.{}", buf[0], buf[1], buf[2], buf[3]);
            let port = u16::from_be_bytes([buf[4], buf[5]]);
            (ip, port)
        }
        0x03 => {
            stream.read_exact(&mut buf[..1]).await?;
            let len = buf[0] as usize;
            stream.read_exact(&mut buf[..len + 2]).await?;
            let host = String::from_utf8_lossy(&buf[..len]).to_string();
            let port = u16::from_be_bytes([buf[len], buf[len + 1]]);
            (host, port)
        }
        0x04 => {
            stream.read_exact(&mut buf[..18]).await?;
            let segs: Vec<String> = buf[..16].chunks(2)
                .map(|c| format!("{:02x}{:02x}", c[0], c[1]))
                .collect();
            let ip = segs.join(":");
            let port = u16::from_be_bytes([buf[16], buf[17]]);
            (ip, port)
        }
        t => return Err(anyhow!("Unknown addr type {}", t)),
    };

    stream.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]).await?;
    Ok((host, port))
}

// ── Tunnel starters ───────────────────────────────────────────────────────────

pub async fn start_tunnel(pf_id: String, params: TunnelParams, state: Arc<TunnelState>) -> Result<()> {
    let TunnelParams { kind, bind_address, ssh_host, ssh_port, ssh_username, auth } = params;
    let base = TunnelBase { bind_address, ssh_host, ssh_port, ssh_username, auth };
    match kind {
        TunnelKind::Local { local_port, dest_host, dest_port } =>
            local_tunnel(pf_id, base, local_port, dest_host, dest_port, state).await,
        TunnelKind::Remote { remote_port, dest_host, dest_port } =>
            remote_tunnel(pf_id, base, remote_port, dest_host, dest_port, state).await,
        TunnelKind::Dynamic { local_port } =>
            dynamic_tunnel(pf_id, base, local_port, state).await,
    }
}

// ── Local (-L) ────────────────────────────────────────────────────────────────

async fn local_tunnel(
    pf_id: String,
    base: TunnelBase,
    local_port: u32,
    dest_host: String,
    dest_port: u32,
    state: Arc<TunnelState>,
) -> Result<()> {
    let handle = Arc::new(Mutex::new(connect_basic(&base).await?));
    let listener = TcpListener::bind(format!("{}:{}", base.bind_address, local_port)).await?;
    let (stop_tx, stop_rx) = oneshot::channel::<()>();

    state.tunnels.lock().await.insert(pf_id, TunnelHandle { stop_tx });

    tokio::spawn(async move {
        let mut stop_rx = stop_rx;
        loop {
            tokio::select! {
                biased;
                _ = &mut stop_rx => break,
                res = listener.accept() => match res {
                    Err(_) => break,
                    Ok((stream, _)) => {
                        let h = Arc::clone(&handle);
                        let dh = dest_host.clone();
                        tokio::spawn(async move {
                            let ch = h.lock().await.channel_open_direct_tcpip(&dh, dest_port, "127.0.0.1", 0).await;
                            if let Ok(ch) = ch { proxy_tcp_channel(stream, ch).await; }
                        });
                    }
                },
            }
        }
        let _ = handle.lock().await.disconnect(Disconnect::ByApplication, "", "en").await;
    });

    Ok(())
}

// ── Remote (-R) ───────────────────────────────────────────────────────────────

async fn remote_tunnel(
    pf_id: String,
    base: TunnelBase,
    remote_port: u32,
    dest_host: String,
    dest_port: u32,
    state: Arc<TunnelState>,
) -> Result<()> {
    let mut handle = connect_remote_fwd(&base, dest_host, dest_port).await?;
    handle.tcpip_forward(base.bind_address.clone(), remote_port).await
        .map_err(|e| anyhow!("tcpip_forward failed: {:?}", e))?;

    let (stop_tx, stop_rx) = oneshot::channel::<()>();
    state.tunnels.lock().await.insert(pf_id, TunnelHandle { stop_tx });

    tokio::spawn(async move {
        let _ = stop_rx.await;
        let _ = handle.disconnect(Disconnect::ByApplication, "", "en").await;
    });

    Ok(())
}

// ── Dynamic SOCKS5 (-D) ───────────────────────────────────────────────────────

async fn dynamic_tunnel(
    pf_id: String,
    base: TunnelBase,
    local_port: u32,
    state: Arc<TunnelState>,
) -> Result<()> {
    let handle = Arc::new(Mutex::new(connect_basic(&base).await?));
    let listener = TcpListener::bind(format!("{}:{}", base.bind_address, local_port)).await?;
    let (stop_tx, stop_rx) = oneshot::channel::<()>();

    state.tunnels.lock().await.insert(pf_id, TunnelHandle { stop_tx });

    tokio::spawn(async move {
        let mut stop_rx = stop_rx;
        loop {
            tokio::select! {
                biased;
                _ = &mut stop_rx => break,
                res = listener.accept() => match res {
                    Err(_) => break,
                    Ok((mut stream, _)) => {
                        let h = Arc::clone(&handle);
                        tokio::spawn(async move {
                            let Ok((host, port)) = socks5_handshake(&mut stream).await else { return; };
                            let ch = h.lock().await.channel_open_direct_tcpip(&host, port as u32, "127.0.0.1", 0).await;
                            if let Ok(ch) = ch { proxy_tcp_channel(stream, ch).await; }
                        });
                    }
                },
            }
        }
        let _ = handle.lock().await.disconnect(Disconnect::ByApplication, "", "en").await;
    });

    Ok(())
}
