//! X11 forwarding: windows opened on the remote host show up here.
//!
//! ssh's `-X`, done the way OpenSSH does it. The session asks with an
//! `x11-req` carrying a cookie, and from then on the server opens an `x11`
//! channel for every program there that connects to the display it set up.
//! Each channel is relayed to the local X server, on the display `DISPLAY`
//! names.
//!
//! The cookie sent to the server is not the real one. It is sixteen random
//! bytes made for this session, and the first thing a program sends down a
//! channel, the X connection setup, has to carry it. That setup is checked
//! and the fake cookie swapped for the real one, read from the local
//! Xauthority, before anything reaches the X server. The server never learns
//! the real cookie, so a copy taken from there opens nothing here once the
//! session is gone; a channel that does not carry the fake one is refused.
//!
//! What a forwarded program can do while the session is open is another
//! matter: it is a client of the local X server like any other, and X lets a
//! client read the keyboard and the screen. That is ssh's `-Y`, the trusted
//! kind, which is the only kind there is here; the host form says so.
//!
//! Off unless the host asked for it, the same as agent forwarding.

use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use russh::client::{ChannelOpenHandle, Msg};
use russh::{Channel, ChannelMsg, ChannelOpenFailure};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt};

use crate::connect::ConnectSecurity;

/// The only authorisation protocol asked for or accepted.
pub const PROTOCOL: &str = "MIT-MAGIC-COOKIE-1";

/// How long a program on the far side has to send its connection setup.
const SETUP_TIMEOUT: Duration = Duration::from_secs(10);

/// Larger than any real setup, which is twelve bytes and a cookie. A channel
/// sending more without finishing one is not speaking X.
const MAX_SETUP: usize = 4096;

/// A local X display: where its server listens, and which screen to use.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Display {
    /// None for this machine's own socket; otherwise a host to reach over TCP.
    pub host: Option<String>,
    pub number: u16,
    pub screen: u32,
}

impl Display {
    /// What `DISPLAY` holds: `:0`, `:0.1`, `unix:0`, `localhost:10.0`.
    pub fn parse(s: &str) -> Option<Display> {
        let (host, rest) = s.trim().rsplit_once(':')?;
        let (number, screen) = match rest.split_once('.') {
            Some((n, sc)) => (n.parse().ok()?, sc.parse().ok()?),
            None => (rest.parse().ok()?, 0),
        };
        // `unix`, and a socket path such as XQuartz puts here, both mean the
        // local socket for that number.
        let host = match host {
            "" | "unix" => None,
            h if h.starts_with('/') => None,
            h => Some(h.to_string()),
        };
        Some(Display { host, number, screen })
    }

    /// The display from the environment, or display 0 when there is none,
    /// which is where a desktop's first X server is. On Windows display 0 is
    /// VcXsrv's or Xming's default, and nothing sets `DISPLAY` there.
    pub fn from_env() -> Display {
        std::env::var("DISPLAY")
            .ok()
            .and_then(|d| Display::parse(&d))
            .unwrap_or(Display { host: None, number: 0, screen: 0 })
    }

    /// As it would be written in `DISPLAY`, for the connection log.
    pub fn name(&self) -> String {
        format!("{}:{}.{}", self.host.as_deref().unwrap_or(""), self.number, self.screen)
    }
}

/// One entry of an Xauthority file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct XauthEntry {
    pub family: u16,
    pub address: Vec<u8>,
    pub number: String,
    pub name: String,
    pub data: Vec<u8>,
}

/// The local socket, named by host.
const FAMILY_LOCAL: u16 = 256;
/// Any host at all.
const FAMILY_WILD: u16 = 65535;

/// Every whole entry in an Xauthority file. The format is a run of records,
/// each a big-endian family and four length-prefixed fields; a file that ends
/// part way through one yields the ones before it.
pub fn parse_xauthority(bytes: &[u8]) -> Vec<XauthEntry> {
    fn field<'a>(b: &mut &'a [u8]) -> Option<&'a [u8]> {
        let len = u16::from_be_bytes([*b.first()?, *b.get(1)?]) as usize;
        let value = b.get(2..2 + len)?;
        *b = &b[2 + len..];
        Some(value)
    }
    let mut entries = Vec::new();
    let mut rest = bytes;
    while rest.len() >= 2 {
        let family = u16::from_be_bytes([rest[0], rest[1]]);
        let mut b = &rest[2..];
        let (Some(address), Some(number), Some(name), Some(data)) =
            (field(&mut b), field(&mut b), field(&mut b), field(&mut b))
        else {
            break;
        };
        entries.push(XauthEntry {
            family,
            address: address.to_vec(),
            number: String::from_utf8_lossy(number).into_owned(),
            name: String::from_utf8_lossy(name).into_owned(),
            data: data.to_vec(),
        });
        rest = b;
    }
    entries
}

/// The cookie for `display`, the way xauth would choose it: an entry for this
/// machine by name first, then one for any host, then any other for that
/// display number.
pub fn find_cookie(entries: &[XauthEntry], display: &Display, hostname: Option<&str>) -> Option<Vec<u8>> {
    let number = display.number.to_string();
    let usable: Vec<&XauthEntry> = entries
        .iter()
        .filter(|e| e.name == PROTOCOL && (e.number == number || e.family == FAMILY_WILD))
        .collect();
    let pick = |want: &dyn Fn(&XauthEntry) -> bool| usable.iter().copied().find(|e| want(e));
    pick(&|e| e.family == FAMILY_LOCAL && hostname.is_some_and(|h| e.address == h.as_bytes()))
        .or_else(|| pick(&|e| e.family == FAMILY_WILD))
        .or_else(|| pick(&|e| e.family == FAMILY_LOCAL))
        .or_else(|| usable.first().copied())
        .map(|e| e.data.clone())
}

/// Where the Xauthority file is: `XAUTHORITY`, else `~/.Xauthority`.
fn xauthority_path() -> Option<std::path::PathBuf> {
    match std::env::var_os("XAUTHORITY") {
        Some(p) if !p.is_empty() => Some(p.into()),
        _ => dirs::home_dir().map(|h| h.join(".Xauthority")),
    }
}

#[cfg(unix)]
fn hostname() -> Option<String> {
    let mut buf = [0u8; 256];
    // SAFETY: the buffer is valid for its whole length, and gethostname
    // writes at most that many bytes into it.
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
    if rc != 0 {
        return None;
    }
    let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
    Some(String::from_utf8_lossy(&buf[..end]).into_owned())
}

#[cfg(not(unix))]
fn hostname() -> Option<String> {
    std::env::var("COMPUTERNAME").ok()
}

/// What checking a channel's first bytes found.
#[derive(Debug, PartialEq, Eq)]
pub enum Setup {
    /// Not a whole setup yet; read more.
    Incomplete,
    /// Not the setup this session handed out a cookie for.
    Refused(&'static str),
    /// The setup with the real cookie in place of the fake one, and how many
    /// bytes of the input it replaces. Whatever follows is passed on as is.
    Ready { setup: Vec<u8>, consumed: usize },
}

const fn pad4(n: usize) -> usize {
    (n + 3) & !3
}

/// Checks a connection setup for the fake cookie and puts the real one in
/// its place, or none at all when there is none to give.
///
/// The setup is a byte-order mark, the protocol version, the lengths of the
/// authorisation name and data, then the two, each padded to four bytes.
/// Lengths are read in the order the mark says, and written back the same.
pub fn rewrite_setup(buf: &[u8], fake: &[u8], real: Option<&[u8]>) -> Setup {
    if buf.len() < 12 {
        return Setup::Incomplete;
    }
    let msb = match buf[0] {
        b'B' => true,
        b'l' => false,
        _ => return Setup::Refused("not an X11 connection"),
    };
    let read16 = |at: usize| {
        let pair = [buf[at], buf[at + 1]];
        if msb { u16::from_be_bytes(pair) } else { u16::from_le_bytes(pair) }
    };
    let name_len = read16(6) as usize;
    let data_len = read16(8) as usize;
    let consumed = 12 + pad4(name_len) + pad4(data_len);
    if buf.len() < consumed {
        return Setup::Incomplete;
    }
    let name = &buf[12..12 + name_len];
    let data_at = 12 + pad4(name_len);
    let data = &buf[data_at..data_at + data_len];
    if name != PROTOCOL.as_bytes() || data != fake {
        return Setup::Refused("the connection did not carry this session's cookie");
    }

    let (name, data): (&[u8], &[u8]) = match real {
        Some(cookie) => (PROTOCOL.as_bytes(), cookie),
        None => (b"", b""),
    };
    let write16 = |v: u16| if msb { v.to_be_bytes() } else { v.to_le_bytes() };
    let mut setup = Vec::with_capacity(12 + pad4(name.len()) + pad4(data.len()));
    setup.extend_from_slice(&buf[..6]);
    setup.extend_from_slice(&write16(name.len() as u16));
    setup.extend_from_slice(&write16(data.len() as u16));
    setup.extend_from_slice(&buf[10..12]);
    setup.extend_from_slice(name);
    setup.resize(12 + pad4(name.len()), 0);
    setup.extend_from_slice(data);
    setup.resize(12 + pad4(name.len()) + pad4(data.len()), 0);
    Setup::Ready { setup, consumed }
}

/// Lowercase hex, which is how a cookie goes in an `x11-req`.
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A connection to the local X server.
trait XStream: AsyncRead + AsyncWrite + Unpin + Send {}
impl<T: AsyncRead + AsyncWrite + Unpin + Send> XStream for T {}

/// Connects to the local X server for `display`.
///
/// On Linux the abstract socket comes first, as OpenSSH's client tries it:
/// it needs no file under /tmp to be visible, which a sandbox may not show.
/// Then the socket file, then TCP, which is the only way on Windows.
async fn connect_display(display: &Display) -> std::io::Result<Box<dyn XStream>> {
    let port = 6000 + display.number;
    if let Some(host) = &display.host {
        return Ok(Box::new(tokio::net::TcpStream::connect((host.as_str(), port)).await?));
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::linux::net::SocketAddrExt;
        let abstract_name = format!("/tmp/.X11-unix/X{}", display.number);
        if let Ok(addr) = std::os::unix::net::SocketAddr::from_abstract_name(abstract_name.as_bytes()) {
            if let Ok(stream) = std::os::unix::net::UnixStream::connect_addr(&addr) {
                stream.set_nonblocking(true)?;
                return Ok(Box::new(tokio::net::UnixStream::from_std(stream)?));
            }
        }
    }
    #[cfg(unix)]
    {
        let path = format!("/tmp/.X11-unix/X{}", display.number);
        if let Ok(stream) = tokio::net::UnixStream::connect(&path).await {
            return Ok(Box::new(stream));
        }
    }
    Ok(Box::new(tokio::net::TcpStream::connect(("127.0.0.1", port)).await?))
}

/// What a session forwarding X11 decided at connect.
struct X11Session {
    display: Display,
    fake: [u8; 16],
    real: Option<Vec<u8>>,
}

/// Held by the connection's handler: whether X11 channels are answered, and
/// how.
#[derive(Clone, Default)]
pub struct X11Forwarding {
    session: Option<Arc<X11Session>>,
    sec: Option<ConnectSecurity>,
}

/// What goes in the session's `x11-req`.
pub struct X11Request {
    pub cookie_hex: String,
    pub screen: u32,
    /// For the connection log: the display, and where its cookie came from.
    pub described: String,
}

impl X11Forwarding {
    /// Any X11 channel the server opens is refused.
    pub fn disallowed() -> Self {
        X11Forwarding::default()
    }

    /// Ready to forward to the local display, with a new fake cookie, and
    /// the request the session should send.
    pub fn allowed(sec: ConnectSecurity) -> (Self, X11Request) {
        let display = Display::from_env();
        let real = xauthority_path()
            .and_then(|p| std::fs::read(p).ok())
            .and_then(|bytes| find_cookie(&parse_xauthority(&bytes), &display, hostname().as_deref()));
        let fake: [u8; 16] = rand::random();
        let described = format!(
            "Forwarding X11 to display {}{}",
            display.name(),
            if real.is_some() { ", with its cookie from Xauthority" } else { ", which has no Xauthority cookie, so without one" },
        );
        let request = X11Request { cookie_hex: hex(&fake), screen: display.screen, described };
        let session = X11Session { display, fake, real };
        (X11Forwarding { session: Some(Arc::new(session)), sec: Some(sec) }, request)
    }

    /// The server asked to open an X11 channel.
    pub async fn open(&self, channel: Channel<Msg>, reply: ChannelOpenHandle) {
        let Some(session) = self.session.clone() else {
            // Not asked for, so not answered: refused, so nothing on the far
            // side is left waiting on it.
            reply.reject(ChannelOpenFailure::AdministrativelyProhibited).await;
            return;
        };
        match connect_display(&session.display).await {
            Ok(stream) => {
                reply.accept().await;
                let sec = self.sec.clone();
                tokio::spawn(async move {
                    if let Err(e) = serve(channel, stream, &session).await {
                        log(&sec, "error", &format!("X11 forwarding: {e:#}"));
                    }
                });
            }
            Err(e) => {
                log(&self.sec, "error", &format!("X11 forwarding: could not reach display {}: {e}", session.display.name()));
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

/// Checks the channel's setup, passes it on with the real cookie, then
/// relays both ways until either side is done.
async fn serve(mut channel: Channel<Msg>, mut stream: Box<dyn XStream>, session: &X11Session) -> Result<()> {
    let mut buf = Vec::new();
    let setup = tokio::time::timeout(SETUP_TIMEOUT, async {
        loop {
            match rewrite_setup(&buf, &session.fake, session.real.as_deref()) {
                Setup::Ready { setup, consumed } => return Ok((setup, consumed)),
                Setup::Refused(why) => return Err(anyhow!("refused a connection: {why}")),
                Setup::Incomplete if buf.len() > MAX_SETUP => return Err(anyhow!("refused a connection: not an X11 setup")),
                Setup::Incomplete => {}
            }
            match channel.wait().await {
                Some(ChannelMsg::Data { data }) => buf.extend_from_slice(&data),
                Some(ChannelMsg::Eof | ChannelMsg::Close) | None => return Err(anyhow!("the connection closed before it began")),
                Some(_) => {}
            }
        }
    })
    .await
    .map_err(|_| anyhow!("refused a connection that sent no setup"))
    .and_then(|r| r);

    let (setup, consumed) = match setup {
        Ok(found) => found,
        Err(e) => {
            let _ = channel.close().await;
            return Err(e);
        }
    };
    stream.write_all(&setup).await?;
    stream.write_all(&buf[consumed..]).await?;
    crate::tunnel::proxy_channel(stream, channel).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn displays_are_read_the_way_x_writes_them() {
        let local = |number, screen| Some(Display { host: None, number, screen });
        assert_eq!(Display::parse(":0"), local(0, 0));
        assert_eq!(Display::parse(":1.2"), local(1, 2));
        assert_eq!(Display::parse("unix:3"), local(3, 0));
        assert_eq!(Display::parse("/tmp/launch-abc/org.xquartz:0"), local(0, 0));
        assert_eq!(
            Display::parse("localhost:10.0"),
            Some(Display { host: Some("localhost".into()), number: 10, screen: 0 }),
        );
        for bad in ["", "0", ":", ":x", ":0.y", "host"] {
            assert_eq!(Display::parse(bad), None, "{bad:?}");
        }
    }

    fn entry(family: u16, address: &str, number: &str, data: &[u8]) -> Vec<u8> {
        let mut out = family.to_be_bytes().to_vec();
        for field in [address.as_bytes(), number.as_bytes(), PROTOCOL.as_bytes(), data] {
            out.extend_from_slice(&(field.len() as u16).to_be_bytes());
            out.extend_from_slice(field);
        }
        out
    }

    #[test]
    fn an_xauthority_file_is_read_entry_by_entry() {
        let mut file = entry(FAMILY_LOCAL, "box", "0", &[1; 16]);
        file.extend(entry(FAMILY_WILD, "", "1", &[2; 16]));
        let entries = parse_xauthority(&file);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].address, b"box");
        assert_eq!(entries[1].number, "1");

        // Cut short in the second entry: the first still counts.
        assert_eq!(parse_xauthority(&file[..file.len() - 3]).len(), 1);
    }

    #[test]
    fn the_cookie_for_this_machine_wins() {
        let mut file = entry(FAMILY_LOCAL, "other", "0", &[1; 16]);
        file.extend(entry(FAMILY_WILD, "", "0", &[2; 16]));
        file.extend(entry(FAMILY_LOCAL, "box", "0", &[3; 16]));
        file.extend(entry(FAMILY_LOCAL, "box", "1", &[4; 16]));
        let entries = parse_xauthority(&file);
        let d0 = Display { host: None, number: 0, screen: 0 };

        assert_eq!(find_cookie(&entries, &d0, Some("box")), Some(vec![3; 16]));
        assert_eq!(find_cookie(&entries, &d0, Some("unknown")), Some(vec![2; 16]), "wild next");
        assert_eq!(find_cookie(&entries, &Display { number: 1, ..d0.clone() }, Some("box")), Some(vec![4; 16]));
        assert_eq!(find_cookie(&entries, &Display { number: 7, ..d0 }, Some("box")), Some(vec![2; 16]), "wild is any display");
        assert_eq!(find_cookie(&[], &Display::parse(":0").unwrap(), None), None);
    }

    /// A connection setup as a client would send it.
    fn setup(msb: bool, name: &[u8], data: &[u8]) -> Vec<u8> {
        let w = |v: u16| if msb { v.to_be_bytes() } else { v.to_le_bytes() };
        let mut out = vec![if msb { b'B' } else { b'l' }, 0];
        out.extend_from_slice(&w(11));
        out.extend_from_slice(&w(0));
        out.extend_from_slice(&w(name.len() as u16));
        out.extend_from_slice(&w(data.len() as u16));
        out.extend_from_slice(&[0, 0]);
        out.extend_from_slice(name);
        out.resize(12 + pad4(name.len()), 0);
        out.extend_from_slice(data);
        out.resize(12 + pad4(name.len()) + pad4(data.len()), 0);
        out
    }

    #[test]
    fn the_fake_cookie_is_swapped_for_the_real_one() {
        let (fake, real) = ([7u8; 16], [9u8; 16]);
        for msb in [true, false] {
            let sent = setup(msb, PROTOCOL.as_bytes(), &fake);
            let mut stream = sent.clone();
            stream.extend_from_slice(b"first request");
            match rewrite_setup(&stream, &fake, Some(&real)) {
                Setup::Ready { setup: out, consumed } => {
                    assert_eq!(out, setup(msb, PROTOCOL.as_bytes(), &real));
                    assert_eq!(consumed, sent.len());
                    assert_eq!(&stream[consumed..], b"first request");
                }
                other => panic!("{other:?}"),
            }
        }
    }

    #[test]
    fn with_no_real_cookie_the_setup_asks_for_none() {
        let fake = [7u8; 16];
        let Setup::Ready { setup: out, .. } = rewrite_setup(&setup(false, PROTOCOL.as_bytes(), &fake), &fake, None) else {
            panic!("expected a setup");
        };
        assert_eq!(out, setup(false, b"", b""));
    }

    #[test]
    fn a_setup_split_across_reads_waits_for_the_rest() {
        let fake = [7u8; 16];
        let whole = setup(true, PROTOCOL.as_bytes(), &fake);
        for cut in [0, 5, 12, 20, whole.len() - 1] {
            assert_eq!(rewrite_setup(&whole[..cut], &fake, None), Setup::Incomplete, "cut at {cut}");
        }
    }

    #[test]
    fn anything_but_this_sessions_cookie_is_refused() {
        let fake = [7u8; 16];
        assert!(matches!(rewrite_setup(&setup(true, PROTOCOL.as_bytes(), &[8; 16]), &fake, None), Setup::Refused(_)));
        assert!(matches!(rewrite_setup(&setup(true, b"XDM-AUTHORIZATION-1", &fake), &fake, None), Setup::Refused(_)));
        assert!(matches!(rewrite_setup(&setup(true, b"", b""), &fake, None), Setup::Refused(_)));
        assert!(matches!(rewrite_setup(b"GET / HTTP/1.1\r\n", &fake, None), Setup::Refused(_)));
    }

    #[test]
    fn a_cookie_goes_out_as_lowercase_hex() {
        assert_eq!(hex(&[0x00, 0xab, 0x7f]), "00ab7f");
    }
}
