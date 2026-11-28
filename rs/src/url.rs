//! `new URL(text)` for the URLs a winrpc client is given, where its answer
//! is certain.
//!
//! The WHATWG URL parser behind bun's `URL` takes much more than a winrpc
//! URL looks like (other schemes, IPv6 and shortened IPv4 hosts,
//! internationalised names, percent escapes, dot segments, `http:x`). This
//! reads one shape and says `Unsure` for everything else, so that the
//! invocation goes back to the JavaScript:
//!
//!   http://[user[:password]@]host[:port][/path]     (or https)
//!
//! - the text is printable ASCII without spaces (so the parser's trimming
//!   and removal of tabs and newlines have nothing to do);
//! - the scheme `http` or `https`, in any case, followed by exactly `//`;
//! - user and password made of letters, digits and `-._~`, one `@` at most
//!   (nothing to percent-encode, nothing to decode);
//! - the host a canonical dotted IPv4 address (four numbers from 0 to 255,
//!   without leading zeros), or a name of letters, digits, `-` and `.` whose
//!   labels are not empty, do not start or end with `-`, hold no `--`, are
//!   63 characters at most, and whose last label is not a number (that would
//!   make it an IPv4 address of another spelling); letters are lowercased;
//! - the port digits, the scheme's default left out;
//! - the path `/`-separated segments of letters, digits and `-._~!$&'()*+,;=:@`,
//!   none of them empty (but the last), `.` or `..`; no query, no
//!   fragment, no backslash.
//!
//! `Invalid` is for text `new URL` certainly throws on: no scheme at all
//! (`notaurl`, `my keys`, ` x`), no host (`http://`, `http://user@`, `http://:80`), a port
//! that is not a number or above 65535, a host that opens a `[` it never
//! closes (`http://x@[bad`).

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Url {
    /// `http` or `https`
    pub scheme: String,
    /// `url.username`, as written (there is nothing to decode).
    pub username: String,
    /// `url.password`
    pub password: String,
    /// Lowercased.
    pub host: String,
    /// None for the scheme's default.
    pub port: Option<u16>,
    /// At least `/`.
    pub path: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Parsed {
    Invalid,
    Unsure,
}

impl Url {
    /// `url.toString()` once username and password are cleared. The client
    /// prints it nowhere since a failed connection goes back; the tests
    /// compare it with bun's.
    #[cfg(test)]
    pub fn without_credentials(&self) -> String {
        let port = self.port.map(|p| format!(":{p}")).unwrap_or_default();
        format!("{}://{}{}{}", self.scheme, self.host, port, self.path)
    }

    /// The port a request goes to.
    pub fn port_or_default(&self) -> u16 {
        self.port.unwrap_or(if self.scheme == "https" { 443 } else { 80 })
    }
}

fn is_scheme_start(text: &str) -> bool {
    let bytes = text.as_bytes();
    let Some(colon) = text.find(':') else { return false };
    colon > 0 && bytes[0].is_ascii_alphabetic() && bytes[1..colon].iter().all(|&b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'-' | b'.'))
}

fn credential(text: &str) -> bool {
    text.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~'))
}

fn path_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || b"-._~!$&'()*+,;=:@/".contains(&b)
}

/// A canonical dotted IPv4 address.
fn canonical_ipv4(host: &str) -> bool {
    let parts: Vec<&str> = host.split('.').collect();
    parts.len() == 4
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.len() <= 3
                && part.bytes().all(|b| b.is_ascii_digit())
                && (part.len() == 1 || !part.starts_with('0'))
                && part.parse::<u16>().is_ok_and(|n| n <= 255)
        })
}

/// The last label "ends in a number" (WHATWG): digits only, or 0x and hex.
fn ends_in_a_number(host: &str) -> bool {
    let last = host.trim_end_matches('.').rsplit('.').next().unwrap_or("");
    (!last.is_empty() && last.bytes().all(|b| b.is_ascii_digit()))
        || ((last.starts_with("0x") || last.starts_with("0X")) && last[2..].bytes().all(|b| b.is_ascii_hexdigit()))
}

fn plain_name(host: &str) -> bool {
    host.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            && !label.starts_with('-')
            && !label.ends_with('-')
            && !label.contains("--")
    })
}

pub fn parse(raw: &str) -> Result<Url, Parsed> {
    // The parser first drops C0 controls and spaces at both ends and every
    // tab and newline; with no base URL, text without a scheme then fails.
    let cleaned: String = raw.trim_matches(|c: char| c <= ' ').chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect();
    if !is_scheme_start(&cleaned) {
        return Err(Parsed::Invalid);
    }
    if !raw.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return Err(Parsed::Unsure);
    }
    let colon = raw.find(':').unwrap_or(0);
    let scheme = raw[..colon].to_ascii_lowercase();
    if scheme != "http" && scheme != "https" {
        return Err(Parsed::Unsure);
    }
    let Some(rest) = raw[colon + 1..].strip_prefix("//") else { return Err(Parsed::Unsure) };
    if rest.starts_with('/') || rest.contains(['?', '#', '\\']) {
        return Err(Parsed::Unsure);
    }
    let (authority, path) = match rest.find('/') {
        Some(at) => (&rest[..at], &rest[at..]),
        None => (rest, ""),
    };
    let (userinfo, hostport) = match authority.split_once('@') {
        Some((userinfo, hostport)) => (Some(userinfo), hostport),
        None => (None, authority),
    };
    if hostport.contains('@') {
        return Err(Parsed::Unsure);
    }
    let (username, password) = match userinfo {
        None => ("", ""),
        Some(userinfo) => match userinfo.split_once(':') {
            Some((user, password)) => (user, password),
            None => (userinfo, ""),
        },
    };
    let credentials_plain = credential(username) && credential(password);
    if hostport.is_empty() || hostport.starts_with(':') {
        // No host: "host-missing", whatever else there is.
        return Err(Parsed::Invalid);
    }
    if hostport.starts_with('[') {
        return Err(if hostport.contains(']') || !credentials_plain { Parsed::Unsure } else { Parsed::Invalid });
    }
    let (host, port) = match hostport.split_once(':') {
        Some((host, port)) => (host, Some(port)),
        None => (hostport, None),
    };
    let host = host.to_ascii_lowercase();
    let host_plain = if ends_in_a_number(&host) { canonical_ipv4(&host) } else { plain_name(&host) };
    if !credentials_plain || !host_plain || !path.bytes().all(path_byte) {
        return Err(Parsed::Unsure);
    }
    // bun's fetch asks for `/lock` where the URL says `//lock`: no empty
    // segments.
    if path.contains("//") || path.split('/').any(|segment| segment == "." || segment == "..") {
        return Err(Parsed::Unsure);
    }
    let port = match port {
        None | Some("") => None,
        Some(digits) => {
            if !digits.bytes().all(|b| b.is_ascii_digit()) {
                return Err(Parsed::Invalid);
            }
            let trimmed = digits.trim_start_matches('0');
            if trimmed.len() > 5 {
                return Err(Parsed::Invalid);
            }
            let number: u32 = if trimmed.is_empty() { 0 } else { trimmed.parse().map_err(|_| Parsed::Unsure)? };
            if number > 65535 {
                return Err(Parsed::Invalid);
            }
            let default = if scheme == "https" { 443 } else { 80 };
            (number != default).then_some(number as u16)
        }
    };
    Ok(Url {
        scheme,
        username: username.to_string(),
        password: password.to_string(),
        host,
        port,
        path: if path.is_empty() { "/".to_string() } else { path.to_string() },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shown(raw: &str) -> Result<String, Parsed> {
        parse(raw).map(|url| url.without_credentials())
    }

    // Each beside what `new URL(text).toString()` gives in bun 1.4.0, with
    // username and password cleared (or that it throws).
    #[test]
    fn plain_urls() {
        assert_eq!(shown("http://127.0.0.1:12371"), Ok("http://127.0.0.1:12371/".into()));
        assert_eq!(shown("http://tok@127.0.0.1:12371/"), Ok("http://127.0.0.1:12371/".into()));
        assert_eq!(shown("HTTP://LOCALHOST:0009/A/b"), Ok("http://localhost:9/A/b".into()));
        assert_eq!(shown("http://h:80/x/"), Ok("http://h/x/".into()));
        assert_eq!(shown("https://h:443"), Ok("https://h/".into()));
        assert_eq!(shown("https://h:80"), Ok("https://h:80/".into()));
        assert_eq!(shown("http://h:"), Ok("http://h/".into()));
        assert_eq!(shown("http://h:0"), Ok("http://h:0/".into()));
        assert_eq!(shown("http://h:000000000000"), Ok("http://h:0/".into()));
        assert_eq!(shown("http://u:p@my-host.example:1/a/"), Ok("http://my-host.example:1/a/".into()));
        let url = parse("http://user.name:pa~ss@h").unwrap();
        assert_eq!((url.username.as_str(), url.password.as_str()), ("user.name", "pa~ss"));
        let url = parse("http://:pw@h").unwrap();
        assert_eq!((url.username.as_str(), url.password.as_str()), ("", "pw"));
    }

    #[test]
    fn certainly_invalid() {
        for raw in ["notaurl", "my keys", " \t", "dir/k", "clés→鍵", "a\tb c", "1http://x", "://x", "http://", "http://tok@", "http://:80", "http://u@:80", "http://x@[bad", "http://[bad", "http://h:99999", "http://h:65536", "http://h:12a", "http://h:-1"] {
            assert_eq!(parse(raw), Err(Parsed::Invalid), "{raw}");
        }
    }

    #[test]
    fn unsure_of_the_rest() {
        for raw in [
            "http://a b", " http://h", "ht\ttp://h", "a\tb:c", "http://h/\u{e9}", "ftp://h", "file:///x", "http:x", "http:/x", "http:///x", "http://h?x", "http://h#x", "http://h\\x",
            "http://[::1]:1", "http://127.1", "http://1.2.3.04", "http://256.0.0.1", "http://0x7f.0.0.1", "http://a.1", "http://a..b", "http://a.",
            "http://-a", "http://xn--a", "http://a_b", "http://a@b@c", "http://u:p:q@h", "http://u%41@h", "http://h/%41", "http://h/a/../b", "http://h/./b", "http://h//", "http://h/a//b",
            "http://h/a b", "http://h/a\"b", "http://h/<", "http://h/`", "http://h/{", "http://h/^",
        ] {
            assert_eq!(parse(raw), Err(Parsed::Unsure), "{raw}");
        }
    }
}
