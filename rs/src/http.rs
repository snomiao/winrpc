//! The one request a ported command makes: `GET` over plain HTTP/1.1, as
//! bun's `fetch` makes it for `winrpc lock` (src/index.ts `postJson` without
//! a body), with what it reads of the answer.
//!
//! Only what is certain to come out the same is taken. Everything else is
//! `HandBack`, which is safe here because the request only reads: the
//! JavaScript makes it again and answers in its own way. The binary does
//! not follow a redirect, does not decompress (it asks for nothing but
//! sends no Accept-Encoding, so a server that keeps to HTTP sends none) and
//! does not do TLS; it does not resolve names. `localhost` is where bun
//! goes for it (measured with a server on ::1 and another on 127.0.0.1,
//! the same port) on macOS (bun 1.4.4, 1.4.5) and Windows (bun 1.4.2,
//! 1.4.5): ::1 first, and 127.0.0.1 when ::1 refuses. That holds for the
//! hosts file these systems come with (see `localhost`); another goes back.
//! On Linux `localhost` goes back, because where bun goes there depends on
//! bun's version and on the machine. bun 1.4.0 asks getaddrinfo with
//! AF_UNSPEC, SOCK_STREAM and AI_ADDRCONFIG, and glibc counts no loopback
//! address for AI_ADDRCONFIG: where ::1 is the only IPv6 address (a
//! container on an IPv4-only network) it asks for IPv4 alone and gets
//! 127.0.0.1, even from a hosts file that names ::1 (measured: refused
//! where only ::1 listens); where any other IPv6 address is configured, a
//! link-local one too, it gets both, in the order of gai.conf (::1 first
//! by default). bun 1.4.1 and later (oven-sh/bun#38818) answer `localhost`
//! themselves, ::1 then 127.0.0.1, whatever /etc/hosts or gai.conf say
//! (measured with 1.4.5 on the same machine: ::1). The binary cannot tell
//! which bun the JavaScript will run on. And it goes back for:
//!
//! - a host that is not a canonical IPv4 address or `localhost`, `localhost`
//!   on Linux, an https URL, or a proxy in the environment (see
//!   `Machine::proxy_set`);
//! - a connection that fails (refused too: bun names that in words of its
//!   own, which differ by system), that takes more than 30 s, or that is
//!   closed or stalls (30 s) before a whole answer has arrived. bun waits
//!   longer: a server that answers after 30 s gets the GET twice, and the
//!   user waits for both;
//! - a status line other than `HTTP/1.x <3 digits> <reason>`, a status
//!   outside 200-599 or a 3xx; a reason phrase that is empty or not plain
//!   printable ASCII;
//! - a header line that is not `name: value` in printable ASCII, a
//!   Content-Encoding, a Transfer-Encoding other than `chunked`, both a
//!   Transfer-Encoding and a Content-Length, a Content-Length given twice or
//!   not a number, a body shorter than its Content-Length, a chunk size
//!   that is not plain hex, chunk extensions or trailers.

use std::io::{ErrorKind, Read, Write};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, TcpStream};
use std::time::Duration;

use crate::url::Url;
use crate::HandBack;

pub struct Response {
    pub status: u16,
    /// `res.statusText`: the reason phrase as sent.
    pub reason: String,
    pub body: Vec<u8>,
}

const WAIT: Duration = Duration::from_secs(30);
const MAX_HEAD: usize = 64 * 1024;

/// The addresses bun tries for the URL's host, in its order.
fn addresses(url: &Url) -> Result<Vec<SocketAddr>, HandBack> {
    if url.scheme != "http" {
        return Err(HandBack);
    }
    let ips: Vec<IpAddr> = if url.host == "localhost" { localhost(&hosts_file()?)? } else { vec![IpAddr::V4(url.host.parse::<Ipv4Addr>().map_err(|_| HandBack)?)] };
    Ok(ips.into_iter().map(|ip| SocketAddr::new(ip, url.port_or_default())).collect())
}

/// The hosts file, `None` where there is none.
fn hosts_file() -> Result<Option<String>, HandBack> {
    let path = if cfg!(windows) {
        let root = std::env::var_os("SystemRoot").ok_or(HandBack)?;
        std::path::Path::new(&root).join("System32").join("drivers").join("etc").join("hosts")
    } else {
        std::path::PathBuf::from("/etc/hosts")
    };
    match std::fs::read(&path) {
        Ok(bytes) => String::from_utf8(bytes).map(Some).map_err(|_| HandBack),
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(None),
        Err(_) => Err(HandBack),
    }
}

/// Where bun goes for `localhost`, for a hosts file of the shape macOS and
/// Windows come with: macOS names 127.0.0.1 and ::1 for it, Windows neither
/// (its resolver answers for localhost itself). Any other shape goes back,
/// and so does every one on Linux (see the top of this file).
fn localhost(hosts: &Option<String>) -> Result<Vec<IpAddr>, HandBack> {
    if cfg!(target_os = "linux") {
        return Err(HandBack);
    }
    let mut named: Vec<&str> = Vec::new();
    for line in hosts.as_deref().unwrap_or("").lines() {
        let line = line.split('#').next().unwrap_or("");
        let mut words = line.split_ascii_whitespace();
        let Some(address) = words.next() else { continue };
        if words.any(|name| name.eq_ignore_ascii_case("localhost")) && !named.contains(&address) {
            named.push(address);
        }
    }
    let only = |wanted: &[&str]| named.len() == wanted.len() && wanted.iter().all(|address| named.contains(address));
    let (v4, v6) = (IpAddr::V4(Ipv4Addr::LOCALHOST), IpAddr::V6(Ipv6Addr::LOCALHOST));
    if (cfg!(target_os = "macos") && only(&["127.0.0.1", "::1"])) || (cfg!(windows) && named.is_empty()) {
        Ok(vec![v6, v4])
    } else {
        Err(HandBack)
    }
}

/// A connection to the first address that takes one. One that is refused
/// moves on to the next; one that takes too long, or none at all, goes
/// back.
fn connect(addresses: &[SocketAddr]) -> Result<TcpStream, HandBack> {
    for address in addresses {
        match TcpStream::connect_timeout(address, WAIT) {
            Ok(stream) => return Ok(stream),
            Err(err) if err.kind() == ErrorKind::TimedOut || err.kind() == ErrorKind::WouldBlock => return Err(HandBack),
            Err(_) => continue,
        }
    }
    Err(HandBack)
}

/// `GET <base><path>` with these headers. A connection that fails, refused
/// too, goes back: bun reports it in words of its own that differ by system
/// and by version (ConnectionRefused on Linux with bun 1.4.0, ECONNREFUSED
/// there with 1.4.5 and on macOS).
pub fn get(url: &Url, target: &str, headers: &[(&str, String)]) -> Result<Response, HandBack> {
    let mut stream = connect(&addresses(url)?)?;
    stream.set_read_timeout(Some(WAIT)).map_err(|_| HandBack)?;
    stream.set_write_timeout(Some(WAIT)).map_err(|_| HandBack)?;
    let host = match url.port {
        Some(port) => format!("{}:{port}", url.host),
        None => url.host.clone(),
    };
    let mut request = format!("GET {target} HTTP/1.1\r\nHost: {host}\r\n");
    for (name, value) in headers {
        request.push_str(&format!("{name}: {value}\r\n"));
    }
    request.push_str("Accept: */*\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).map_err(|_| HandBack)?;
    read_response(&mut stream)
}

struct Reader<'a> {
    stream: &'a mut dyn Read,
    buffer: Vec<u8>,
    at: usize,
    ended: bool,
}

impl Reader<'_> {
    /// Reads more; false at the end of the stream.
    fn fill(&mut self) -> Result<bool, HandBack> {
        if self.ended {
            return Ok(false);
        }
        let mut chunk = [0u8; 16 * 1024];
        loop {
            match self.stream.read(&mut chunk) {
                Ok(0) => {
                    self.ended = true;
                    return Ok(false);
                }
                Ok(n) => {
                    self.buffer.extend_from_slice(&chunk[..n]);
                    return Ok(true);
                }
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return Err(HandBack),
            }
        }
    }

    /// The next `n` bytes.
    fn take(&mut self, n: usize) -> Result<Vec<u8>, HandBack> {
        while self.buffer.len() - self.at < n {
            if !self.fill()? {
                return Err(HandBack);
            }
        }
        let out = self.buffer[self.at..self.at + n].to_vec();
        self.at += n;
        Ok(out)
    }

    /// The next line, without its CRLF.
    fn line(&mut self) -> Result<Vec<u8>, HandBack> {
        loop {
            if let Some(end) = self.buffer[self.at..].windows(2).position(|w| w == b"\r\n") {
                let out = self.buffer[self.at..self.at + end].to_vec();
                self.at += end + 2;
                return Ok(out);
            }
            if self.buffer.len() - self.at > MAX_HEAD || !self.fill()? {
                return Err(HandBack);
            }
        }
    }

    fn rest(&mut self) -> Result<Vec<u8>, HandBack> {
        while self.fill()? {}
        let out = self.buffer[self.at..].to_vec();
        self.at = self.buffer.len();
        Ok(out)
    }
}

fn printable(bytes: &[u8]) -> bool {
    bytes.iter().all(|&b| (0x20..0x7f).contains(&b) || b == b'\t')
}

fn token_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b)
}

pub fn read_response(stream: &mut dyn Read) -> Result<Response, HandBack> {
    let mut reader = Reader { stream, buffer: Vec::new(), at: 0, ended: false };
    let status_line = reader.line()?;
    let status_line = std::str::from_utf8(&status_line).map_err(|_| HandBack)?;
    let rest = status_line.strip_prefix("HTTP/1.1 ").or_else(|| status_line.strip_prefix("HTTP/1.0 ")).ok_or(HandBack)?;
    let (code, reason) = rest.split_once(' ').ok_or(HandBack)?;
    if code.len() != 3 || !code.bytes().all(|b| b.is_ascii_digit()) {
        return Err(HandBack);
    }
    let status: u16 = code.parse().map_err(|_| HandBack)?;
    if !(200..=599).contains(&status) || (300..400).contains(&status) {
        return Err(HandBack);
    }
    let reason_plain = !reason.is_empty()
        && reason.bytes().all(|b| (0x21..0x7f).contains(&b) || b == b' ')
        && !reason.starts_with(' ')
        && !reason.ends_with(' ')
        && !reason.contains("  ");
    if !reason_plain {
        return Err(HandBack);
    }
    let mut length: Option<usize> = None;
    let mut chunked = false;
    let mut transfer_encoding = false;
    loop {
        let line = reader.line()?;
        if line.is_empty() {
            break;
        }
        if !printable(&line) {
            return Err(HandBack);
        }
        let colon = line.iter().position(|&b| b == b':').ok_or(HandBack)?;
        let (name, value) = (&line[..colon], &line[colon + 1..]);
        if name.is_empty() || !name.iter().all(|&b| token_byte(b)) {
            return Err(HandBack);
        }
        let name = String::from_utf8_lossy(name).to_ascii_lowercase();
        let value = String::from_utf8_lossy(value).trim_matches([' ', '\t']).to_string();
        match name.as_str() {
            "content-length" => {
                if length.is_some() || value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) || value.len() > 15 {
                    return Err(HandBack);
                }
                length = Some(value.parse().map_err(|_| HandBack)?);
            }
            "transfer-encoding" => {
                if transfer_encoding || !value.eq_ignore_ascii_case("chunked") {
                    return Err(HandBack);
                }
                transfer_encoding = true;
                chunked = true;
            }
            "content-encoding" => return Err(HandBack),
            _ => {}
        }
    }
    if transfer_encoding && length.is_some() {
        return Err(HandBack);
    }
    let body = if status == 204 || status == 205 {
        // bun reads no body for these; one that comes all the same is odd.
        if length.is_some_and(|n| n > 0) || chunked {
            return Err(HandBack);
        }
        Vec::new()
    } else if chunked {
        let mut body = Vec::new();
        loop {
            let size_line = reader.line()?;
            if size_line.is_empty() || size_line.len() > 8 || !size_line.iter().all(u8::is_ascii_hexdigit) {
                return Err(HandBack);
            }
            let size = usize::from_str_radix(std::str::from_utf8(&size_line).map_err(|_| HandBack)?, 16).map_err(|_| HandBack)?;
            if size == 0 {
                if !reader.line()?.is_empty() {
                    return Err(HandBack);
                }
                break;
            }
            body.extend(reader.take(size)?);
            if !reader.line()?.is_empty() {
                return Err(HandBack);
            }
        }
        body
    } else if let Some(n) = length {
        reader.take(n)?
    } else {
        reader.rest()?
    };
    Ok(Response { status, reason: reason.to_string(), body })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn where_localhost_goes() {
        let hosts = |text: &str| localhost(&Some(text.to_string()));
        let (v4, v6) = (IpAddr::V4(Ipv4Addr::LOCALHOST), IpAddr::V6(Ipv6Addr::LOCALHOST));
        let linux = "127.0.0.1\tlocalhost\n::1\tlocalhost ip6-localhost ip6-loopback\n";
        let macos = "##\n# localhost is used to configure the loopback interface\n127.0.0.1\tlocalhost\n255.255.255.255\tbroadcasthost\n::1             localhost\n";
        let windows = "# localhost name resolution is handled within DNS itself.\n#\t127.0.0.1       localhost\n#\t::1             localhost\n127.0.0.1 webcode.localhost\n";
        let odd = ["127.0.1.1 localhost\n127.0.0.1 localhost\n", "::1 localhost\n", "127.0.0.1 localhost\n::1 localhost\nfe80::1%lo0 localhost\n", "10.0.0.1 LocalHost\n"];
        if cfg!(target_os = "linux") {
            for text in [linux, macos, windows, "127.0.0.1 localhost # x\n", "127.0.0.1 localhost\n", ""] {
                assert_eq!(hosts(text), Err(HandBack), "{text:?}");
            }
            assert_eq!(localhost(&None), Err(HandBack));
        }
        if cfg!(target_os = "macos") {
            assert_eq!(hosts(macos), Ok(vec![v6, v4]));
            assert_eq!(hosts(linux), Ok(vec![v6, v4]));
            assert_eq!(hosts("127.0.0.1 localhost\n"), Err(HandBack));
            assert_eq!(localhost(&None), Err(HandBack));
        }
        if cfg!(windows) {
            assert_eq!(hosts(windows), Ok(vec![v6, v4]));
            assert_eq!(localhost(&None), Ok(vec![v6, v4]));
            assert_eq!(hosts(linux), Err(HandBack));
        }
        for text in odd {
            assert_eq!(hosts(text), Err(HandBack), "{text:?}");
        }
    }

    fn read(raw: &str) -> Result<(u16, String, String), HandBack> {
        let mut bytes = raw.as_bytes();
        read_response(&mut bytes).map(|r| (r.status, r.reason, String::from_utf8(r.body).unwrap()))
    }

    #[test]
    fn plain_answers() {
        assert_eq!(read("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}"), Ok((200, "OK".into(), "{}".into())));
        assert_eq!(read("HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}extra"), Ok((200, "OK".into(), "{}".into())));
        assert_eq!(read("HTTP/1.1 410 Gone Away\r\ncontent-type: text/plain\r\n\r\nbye"), Ok((410, "Gone Away".into(), "bye".into())));
        assert_eq!(read("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3\r\n{\"a\r\n4\r\n\":1}\r\n0\r\n\r\n"), Ok((200, "OK".into(), "{\"a\":1}".into())));
        assert_eq!(read("HTTP/1.0 204 No Content\r\n\r\n"), Ok((204, "No Content".into(), "".into())));
    }

    #[test]
    fn what_goes_back() {
        for raw in [
            "", "HTTP/1.1 200 OK\r\n", "HTTP/2 200 OK\r\n\r\n", "HTTP/1.1 200\r\n\r\n", "HTTP/1.1 200 \r\n\r\n", "HTTP/1.1 302 Found\r\nLocation: /x\r\n\r\n",
            "HTTP/1.1 101 Switching\r\n\r\n", "HTTP/1.1 600 Odd\r\n\r\n", "HTTP/1.1 200 OK\r\nContent-Encoding: gzip\r\n\r\n", "HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nab",
            "HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 1\r\n\r\na", "HTTP/1.1 200 OK\r\nBad Header: x\r\n\r\n", "HTTP/1.1 200 OK\r\n folded\r\n\r\n",
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: gzip\r\n\r\n", "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n3;x=1\r\nabc\r\n0\r\n\r\n",
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 3\r\n\r\n3\r\nabc\r\n0\r\n\r\n", "HTTP/1.1 200 Ok\u{e9}\r\n\r\n",
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n0\r\nX-Trailer: 1\r\n\r\n",
        ] {
            assert!(read(raw).is_err(), "{raw:?}");
        }
    }
}
