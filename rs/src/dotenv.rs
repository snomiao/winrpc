//! The `.env` files bun loads before the program's first line, in the part
//! of bun's syntax where a value is literally what stands in the file.
//!
//! This is the common setup of a winrpc client: the server's banner tells
//! users to copy the token into the client's `.env.local`, as
//! `WINRPC_URL=http://<token>@host:12371` or `WINRPC_TOKEN=<token>`. bun
//! loads `.env.development.local`, `.env.local`, `.env.development` and
//! `.env` of the current directory (NODE_ENV is unset here: any NODE_*
//! variable hands back before this is read); a variable already set wins,
//! and among the files that order wins.
//!
//! The subset, and its tests below, come from dotenvdotenc's port
//! (rs/src/env.rs there), where every rule was read off bun 1.4.0; the
//! parity cases `bun env: …` (rs/parity.gen.mjs) hold them here, through
//! the value of WINRPC_URL that a client prints.

use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use crate::HandBack;

/// The files bun loads from the current directory, strongest first.
pub const FILES: [&str; 4] = [".env.development.local", ".env.local", ".env.development", ".env"];

/// Variables that would change what bun itself, its `fetch` or its
/// `console` do, or how yargs speaks, if a `.env` file set them. Not
/// imitated: the invocation goes back.
fn changes_the_runtime(key: &str) -> bool {
    let key = key.to_ascii_uppercase();
    matches!(
        key.as_str(),
        "HOME" | "USERPROFILE" | "PATH" | "PATHEXT" | "XDG_CONFIG_HOME" | "TMPDIR" | "TEMP" | "TMP" | "FORCE_COLOR" | "NO_COLOR" | "LANG" | "LANGUAGE" | "TZ"
    ) || key.ends_with("_PROXY")
        || ["BUN_", "NODE_", "MIMALLOC_", "ICU_", "LD_", "DYLD_", "LC_", "YARGS_", "SSL_", "NODE"].iter().any(|start| key.starts_with(start))
}

/// What `String.prototype.trim` removes and `\s` matches: ECMAScript
/// WhiteSpace and LineTerminator.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// Reads one of the files bun loads, if it is written in the subset of bun's
/// syntax where a value is simply the text that stands there:
///
/// - blank lines, and lines starting with `#`;
/// - `KEY=value`: KEY made of letters, digits and `_`, no space before `=`.
///   The value runs to the end of the line or to the first `#`, without the
///   spaces and tabs around it;
/// - `KEY="value"` and `KEY='value'`: the text between the quotes, kept as it
///   is (spaces, `#` and the other kinds of quote included). After the
///   closing quote only spaces and a `#` comment may follow.
///
/// A value must hold no `$`, no control character, and no quote character
/// that could end it or start another (none at all when it is not quoted);
/// a quoted one no backslash either. Those are where bun starts to interpret
/// (expansion, escapes, values over several lines). Lines end in LF or CRLF.
/// A name given twice has its last value. Anything else — `export`,
/// indentation, a key with `.` or `-`, a line without `=`, a BOM — is
/// `HandBack`.
pub fn read(path: &Path) -> Result<Vec<(String, String)>, HandBack> {
    let meta = match fs::metadata(path) {
        Ok(meta) => meta,
        Err(err) if err.kind() == ErrorKind::NotFound => {
            // A dangling link is something.
            return match fs::symlink_metadata(path) {
                Err(err) if err.kind() == ErrorKind::NotFound => Ok(Vec::new()),
                _ => Err(HandBack),
            };
        }
        Err(_) => return Err(HandBack),
    };
    if !meta.is_file() {
        return Err(HandBack);
    }
    let bytes = fs::read(path).map_err(|_| HandBack)?;
    parse(std::str::from_utf8(&bytes).map_err(|_| HandBack)?)
}

const BLANKS: [char; 2] = [' ', '\t'];

/// True for text bun takes literally: no `$`, no control characters, no
/// exotic white space, and none of the quote characters in `quotes`.
fn literal(text: &str, quotes: &[char]) -> bool {
    text.chars().all(|c| !c.is_control() && c != '$' && !quotes.contains(&c) && (c == ' ' || !js_space(c)))
}

const ANY_QUOTE: [char; 3] = ['"', '\'', '`'];

/// The value bun gives to what follows `=` on a line.
fn plain_value(raw: &str) -> Result<&str, HandBack> {
    let raw = raw.trim_start_matches(BLANKS);
    let (value, rest, value_is_literal) = match raw.chars().next() {
        Some(quote @ ('"' | '\'')) => {
            let (inner, rest) = raw[1..].split_once(quote).ok_or(HandBack)?;
            (inner, rest.trim_start_matches(BLANKS), !inner.contains('\\') && literal(inner, &[quote]))
        }
        _ => {
            let (value, rest) = match raw.find('#') {
                Some(at) => (raw[..at].trim_end_matches(BLANKS), &raw[at..]),
                None => (raw.trim_end_matches(BLANKS), ""),
            };
            (value, rest, literal(value, &ANY_QUOTE))
        }
    };
    // `rest` is empty or a comment; a comment is ignored as long as it holds
    // nothing bun might read as the start of something else.
    let rest_is_comment = rest.is_empty() || (rest.starts_with('#') && literal(rest, &ANY_QUOTE) && !rest.contains('\\'));
    if value_is_literal && rest_is_comment {
        Ok(value)
    } else {
        Err(HandBack)
    }
}

/// Environment variable names are case-insensitive on Windows.
pub fn same_name(a: &str, b: &str) -> bool {
    if cfg!(windows) {
        a.eq_ignore_ascii_case(b)
    } else {
        a == b
    }
}

pub fn parse(text: &str) -> Result<Vec<(String, String)>, HandBack> {
    let mut vars: Vec<(String, String)> = Vec::new();
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.contains('\r') {
            return Err(HandBack);
        }
        if line.trim_matches(BLANKS).is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, raw) = line.split_once('=').ok_or(HandBack)?;
        let key_is_plain = key.starts_with(|c: char| c.is_ascii_alphabetic() || c == '_') && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !key_is_plain || changes_the_runtime(key) {
            return Err(HandBack);
        }
        let value = plain_value(raw)?.to_string();
        // The last assignment of a name wins.
        match vars.iter_mut().find(|(k, _)| same_name(k, key)) {
            Some(entry) => entry.1 = value,
            None => vars.push((key.to_string(), value)),
        }
    }
    Ok(vars)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pairs(list: &[(&str, &str)]) -> Result<Vec<(String, String)>, HandBack> {
        Ok(list.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect())
    }

    /// Each line and the value bun 1.4.0 gives it (recorded in dotenvdotenc's
    /// port by running bun in a directory holding the file and printing
    /// process.env).
    #[test]
    fn plain_dotenv_lines_are_read() {
        assert_eq!(parse(""), pairs(&[]));
        assert_eq!(parse("A=1\nB=two words\n"), pairs(&[("A", "1"), ("B", "two words")]));
        assert_eq!(parse("A=1\nB=x\nA=2\n"), pairs(&[("A", "2"), ("B", "x")]));
        assert_eq!(parse("# it's a \"comment\" with $x\r\n\r\nA=1\r\nB= \t padded \t \r\nC="), pairs(&[("A", "1"), ("B", "padded"), ("C", "")]));
        assert_eq!(
            parse("URL=https://user:pa.ss@host.example.com:8080/a/b.git?x=1&y=2\nWIN=C:\\Users\\me\nU=héllo→世界"),
            pairs(&[("URL", "https://user:pa.ss@host.example.com:8080/a/b.git?x=1&y=2"), ("WIN", "C:\\Users\\me"), ("U", "héllo→世界")])
        );
        for (line, value) in [
            ("K=\"a b\"", "a b"),
            ("K=\" a \"", " a "),
            ("K=\"a\"   ", "a"),
            ("K=\"a\" # c", "a"),
            ("K='a b'", "a b"),
            ("K=''", ""),
            ("K=\"\"", ""),
            ("K=\"a#b\"", "a#b"),
            ("K='a # b'", "a # b"),
            ("K=\"a=b\"", "a=b"),
            ("K=\t\"a\"", "a"),
            ("K='a'#c", "a"),
            ("K=\"é→\"", "é→"),
            ("K='{\"a\":1}'", "{\"a\":1}"),
            ("K=\"it's\"", "it's"),
            ("K='a`b'", "a`b"),
            ("K=\"a`b\"", "a`b"),
            ("K=a # c", "a"),
            ("K=a#c", "a"),
            ("K= # c", ""),
            ("K=a b # c d", "a b"),
            ("K=a=b # c=d", "a=b"),
        ] {
            assert_eq!(parse(line), pairs(&[("K", value)]), "{line:?}");
            assert_eq!(parse(&format!("{line}\r\nL=1\r\n")), pairs(&[("K", value), ("L", "1")]), "{line:?} with CRLF");
        }
    }

    #[test]
    fn anything_bun_would_interpret_goes_back() {
        for text in [
            "A=$HOME/x",
            "A=cost$",
            "A=\"$B\"",
            "A='a$b'",
            "A=\"a\\nb\"",
            "A='a\\nb'",
            "A=\"unterminated",
            "A=\"two\nlines\"",
            "A=`backticks`",
            "A=\"a\"b",
            "A=it's",
            "A='it''s'",
            "A=\"a\tb\"",
            "A=1 # it's",
            "A=1 # $x",
            "A=a\tb",
            "A=a\u{a0}b",
            "export A=1",
            " A=1",
            "A =1",
            "A",
            "A.B=1",
            "1A=1",
            "A=1\rB=2",
            "\u{feff}A=1",
            "BUN_ENV=test",
            "PATH=/x",
            "HOME=/x",
            "NODE_OPTIONS=--x",
            "NODE_ENV=production",
            "HTTP_PROXY=http://p",
            "https_proxy=http://p",
            "FORCE_COLOR=1",
            "LANG=de_DE.UTF-8",
            "LC_ALL=C",
            "YARGS_DISABLE_WRAP=1",
        ] {
            assert_eq!(parse(text), Err(HandBack), "{text:?}");
        }
    }
}
