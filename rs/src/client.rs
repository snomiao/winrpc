//! The client side of src/index.ts: `resolveClient`, `postJson` without a
//! body (`winrpc lock` / `lock show`), and what `lock acquire|renew|release`
//! and `ahk-repl` say before they send anything.
//!
//! Native:
//! - every refusal of `resolveClient` (no URL; a URL `new URL` throws on);
//! - `lock acquire` without `--owner`, `lock renew|release` without a lease;
//! - `lock show`: the GET, and the three ways an answer ends it (423,
//!   another status that is not ok, and the JSON printed again). A failed
//!   connection goes back: bun names it in words of its own.
//!
//! Back to the JavaScript, before anything was sent: every request that
//! creates or changes something (`lock acquire|renew|release` with what
//! they need, `ahk-repl` with a URL, which then reads stdin). A hand-back
//! after such a request would send it twice, and what the JavaScript does
//! with every answer a server may give (redirects, compression, yargs's own
//! report of an error thrown while printing) is more than is ported here.
//! `lock show` may go back after its GET (see rs/src/http.rs), which only
//! reads: the server then sees it twice.

use crate::args::{Action, AhkRepl, Lock};
use crate::http;
use crate::json::{self, Fail, Json};
use crate::machine::Machine;
use crate::redact;
use crate::room::{Kind, Stream, Write};
use crate::url::{self, Url};
use crate::{Answer, HandBack};

/// What the TypeScript prints, as it prints it: `console.log` and
/// `console.error` through the redaction of src/redact.ts, and
/// `process.stderr.write` as it is.
pub struct Out<'a> {
    machine: &'a Machine,
    secrets: Vec<String>,
    answer: Answer,
}

impl<'a> Out<'a> {
    pub fn new(machine: &'a Machine) -> Result<Out<'a>, HandBack> {
        Ok(Out { machine, secrets: redact::known(&machine.env)?, answer: Answer::default() })
    }

    fn push(&mut self, stream: Stream, kind: Kind, bytes: Vec<u8>) {
        self.answer.writes.push(Write { stream, kind, bytes });
    }

    /// `console.log(text)`
    pub fn log(&mut self, text: &str) {
        let line = format!("{}\n", redact::redact(text, &self.secrets));
        self.push(Stream::Out, Kind::Console, line.into_bytes());
    }

    /// `console.error(text)`, when bun would not colour it.
    pub fn error(&mut self, text: &str) -> Result<(), HandBack> {
        self.machine.plain_stderr()?;
        let line = format!("{}\n", redact::redact(text, &self.secrets));
        self.push(Stream::Err, Kind::Console, line.into_bytes());
        Ok(())
    }

    /// `process.stderr.write(text)`, which the TypeScript follows with
    /// `process.exit`.
    fn write_stderr(&mut self, text: &str) {
        self.push(Stream::Err, Kind::Raw, text.as_bytes().to_vec());
    }

    pub fn exit(mut self, code: i32) -> Answer {
        self.answer.code = code;
        self.answer
    }

    /// `console.error(text); process.exit(code)`
    fn fail(mut self, text: &str, code: i32) -> Result<Answer, HandBack> {
        self.error(text)?;
        Ok(self.exit(code))
    }
}

struct Client {
    url: Url,
    headers: Vec<(&'static str, String)>,
}

/// `resolveClient(target, lease)`: the client, or the answer of a refusal.
fn resolve<'a>(target: Option<&str>, lease: Option<&str>, out: Out<'a>) -> Result<Result<(Client, Out<'a>), Answer>, HandBack> {
    let env = &out.machine.env;
    let raw = match target {
        Some(target) => Some(target.to_string()),
        None => env.get("WINRPC_URL"),
    };
    let Some(raw) = raw.filter(|raw| !raw.is_empty()) else {
        return out.fail("error: provide <url> / --url or set WINRPC_URL", 2).map(Err);
    };
    let url = match url::parse(&raw) {
        Ok(url) => url,
        Err(url::Parsed::Invalid) => return out.fail(&format!("error: invalid URL: {}", redact::redact_url(&raw)), 2).map(Err),
        Err(url::Parsed::Unsure) => return Err(HandBack),
    };
    let token = if url.username.is_empty() { env.truthy("WINRPC_TOKEN") } else { Some(url.username.clone()) };
    let mut headers = Vec::new();
    if let Some(token) = token {
        headers.push(("authorization", format!("Bearer {token}")));
    }
    let lease = match lease {
        Some(lease) => Some(lease.to_string()),
        None => env.truthy("WINRPC_LEASE"),
    };
    if let Some(lease) = lease.filter(|lease| !lease.is_empty()) {
        headers.push(("x-winrpc-lease", lease));
    }
    Ok(Ok((Client { url, headers }, out)))
}

pub fn lock(args: &Lock, machine: &Machine) -> Result<Answer, HandBack> {
    let out = Out::new(machine)?;
    let (client, out) = match resolve(args.url.as_deref(), None, out)? {
        Ok(resolved) => resolved,
        Err(answer) => return Ok(answer),
    };
    match args.action {
        Action::Show => show(&client, out),
        Action::Acquire => match &args.owner {
            None => out.fail("error: lock acquire needs --owner", 2),
            Some(_) => Err(HandBack),
        },
        Action::Renew | Action::Release => {
            let lease = args.lease.clone().or_else(|| machine.env.get("WINRPC_LEASE"));
            match lease.filter(|lease| !lease.is_empty()) {
                None => out.fail(&format!("error: lock {} needs the lease id (argument or $WINRPC_LEASE)", args.action.name()), 2),
                Some(_) => Err(HandBack),
            }
        }
    }
}

pub fn ahk_repl(args: &AhkRepl, machine: &Machine) -> Result<Answer, HandBack> {
    let out = Out::new(machine)?;
    match resolve(args.url.as_deref(), args.lease.as_deref(), out)? {
        Err(answer) => Ok(answer),
        // A server to send stdin's lines to: the JavaScript does that.
        Ok(_) => Err(HandBack),
    }
}

/// A header value bun's `fetch` sends as it is: printable ASCII, no space at
/// either end (`fetch` would trim it), nothing it would refuse.
fn plain_header(value: &str) -> bool {
    value.bytes().all(|b| (0x20..0x7f).contains(&b)) && !value.starts_with(' ') && !value.ends_with(' ')
}

/// `postJson(c, "/lock")`
fn show(client: &Client, mut out: Out<'_>) -> Result<Answer, HandBack> {
    if out.machine.proxy_set() || !client.headers.iter().all(|(_, value)| plain_header(value)) {
        return Err(HandBack);
    }
    let path = "/lock";
    // `${base}${path}`, where base is the URL without user and password
    // and without a last `/`.
    let target = format!("{}{path}", client.url.path.strip_suffix('/').unwrap_or(&client.url.path));
    let response = http::get(&client.url, &target, &client.headers)?;
    let text = String::from_utf8(response.body).map_err(|_| HandBack)?;
    if text.starts_with('\u{feff}') {
        return Err(HandBack);
    }
    // `let data = {}; try { data = JSON.parse(txt) } catch {}`
    let data = match json::parse_js(&text) {
        Ok(value) => value,
        Err(Fail::Invalid) => Json::Obj(Vec::new()),
        Err(Fail::Unsure) => return Err(HandBack),
    };
    if response.status == 423 {
        let line = lease_held(&data).map_err(|_| HandBack)?;
        out.write_stderr(&line);
        return Ok(out.exit(75));
    }
    if !(200..300).contains(&response.status) {
        out.error(&format!("HTTP {} {} on {path}", response.status, response.reason))?;
        out.error(&text)?;
        return Ok(out.exit(1));
    }
    let shown = json::stringify_js(&data).map_err(|_| HandBack)?;
    out.log(&shown);
    Ok(out.exit(0))
}

/// `printLeaseHeld(data)`
fn lease_held(data: &Json) -> Result<String, Fail> {
    let or_question = |value: Option<&Json>| match value {
        None | Some(Json::Null) => Ok("?".to_string()),
        Some(value) => value.to_js_string(),
    };
    let holder = or_question(data.get("holder"))?;
    let label = match data.get("label") {
        Some(label) if label.truthy()? => format!(" ({})", label.to_js_string()?),
        _ => String::new(),
    };
    let expires = or_question(data.get("expires_at"))?;
    Ok(format!("ui lease held by {holder}{label} until {expires}; retry after it, or pass --lease\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn held(text: &str) -> Result<String, Fail> {
        lease_held(&json::parse_js(text).unwrap_or(Json::Obj(Vec::new())))
    }

    #[test]
    fn the_lease_held_line() {
        let tail = "; retry after it, or pass --lease\n";
        assert_eq!(held(r#"{"holder":"flow-a","label":"x","expires_at":"2026-01-01T00:00:00.000Z"}"#), Ok(format!("ui lease held by flow-a (x) until 2026-01-01T00:00:00.000Z{tail}")));
        assert_eq!(held("{}"), Ok(format!("ui lease held by ? until ?{tail}")));
        assert_eq!(held("not json"), Ok(format!("ui lease held by ? until ?{tail}")));
        assert_eq!(held("[1]"), Ok(format!("ui lease held by ? until ?{tail}")));
        assert_eq!(held(r#"{"holder":null,"label":"","expires_at":0}"#), Ok(format!("ui lease held by ? until 0{tail}")));
        assert_eq!(held(r#"{"holder":{},"label":[],"expires_at":[1,[2]]}"#), Ok(format!("ui lease held by [object Object] () until 1,2{tail}")));
        assert_eq!(held(r#"{"holder":{"toString":"x"}}"#), Err(Fail::Unsure));
    }
}
