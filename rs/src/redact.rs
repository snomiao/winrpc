//! src/redact.ts: what becomes of everything the TypeScript prints through
//! `console.log` and `console.error` (`installConsoleRedaction`). Text
//! written with `process.stderr.write` is not touched.
//!
//! - `redactUrl`: the user part of every URL becomes `***`;
//! - then every known secret of 8 characters or more, longest first, becomes
//!   its first four characters and `…`.
//!
//! The known secrets are `$WINRPC_TOKEN`, trimmed, and the user and password
//! of `$WINRPC_URL` (`knownSecrets`). A token that is not ASCII goes back
//! (the mask cuts it by UTF-16 units), and so does a `$WINRPC_URL` that the
//! URL reader here is not sure of.

use crate::machine::Env;
use crate::url;
use crate::HandBack;

const MIN_SECRET_LEN: usize = 8;

/// `knownSecrets()`, longest first, as `redactSecrets` takes them.
pub fn known(env: &Env) -> Result<Vec<String>, HandBack> {
    let mut found: Vec<String> = Vec::new();
    let mut add = |secret: &str| {
        if !found.iter().any(|known| known == secret) {
            found.push(secret.to_string());
        }
    };
    if let Some(token) = env.get("WINRPC_TOKEN") {
        if !token.is_ascii() {
            return Err(HandBack);
        }
        // String.prototype.trim, of ASCII text.
        let token = token.trim_matches(|c: char| matches!(c, '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' '));
        if !token.is_empty() {
            add(token);
        }
    }
    if let Some(raw) = env.get("WINRPC_URL").filter(|raw| !raw.is_empty()) {
        match url::parse(&raw) {
            Ok(url) => {
                if !url.username.is_empty() {
                    add(&url.username);
                }
                if !url.password.is_empty() {
                    add(&url.password);
                }
            }
            // `new URL` throws, and the catch adds nothing.
            Err(url::Parsed::Invalid) => {}
            Err(url::Parsed::Unsure) => return Err(HandBack),
        }
    }
    found.retain(|secret| secret.len() >= MIN_SECRET_LEN);
    // A stable sort, as Array.prototype.sort is.
    found.sort_by_key(|secret| std::cmp::Reverse(secret.len()));
    Ok(found)
}

/// JavaScript's `\s`: WhiteSpace and LineTerminator.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\u{9}' | '\u{a}' | '\u{b}' | '\u{c}' | '\u{d}' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// `s.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@")`
pub fn redact_url(s: &str) -> String {
    let chars: Vec<(usize, char)> = s.char_indices().collect();
    let end_of = |i: usize| chars.get(i).map_or(s.len(), |(at, _)| *at);
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i].1.is_ascii_alphabetic() {
            let mut j = i + 1;
            while j < chars.len() && (chars[j].1.is_ascii_alphanumeric() || matches!(chars[j].1, '+' | '.' | '-')) {
                j += 1;
            }
            let slashes = j + 2 < chars.len() && chars[j].1 == ':' && chars[j + 1].1 == '/' && chars[j + 2].1 == '/';
            if slashes {
                let user = j + 3;
                let mut k = user;
                while k < chars.len() && !js_space(chars[k].1) && chars[k].1 != '/' && chars[k].1 != '@' {
                    k += 1;
                }
                if k > user && k < chars.len() && chars[k].1 == '@' {
                    out.push_str(&s[end_of(i)..end_of(user)]);
                    out.push_str("***@");
                    i = k + 1;
                    continue;
                }
            }
        }
        out.push(chars[i].1);
        i += 1;
    }
    out
}

/// `mask(secret)`: its first four characters (ASCII here) and an ellipsis.
fn mask(secret: &str) -> String {
    format!("{}…", &secret[..4])
}

/// `redactSecrets(s, secrets)`
pub fn redact(s: &str, secrets: &[String]) -> String {
    let mut r = redact_url(s);
    for secret in secrets {
        r = r.replace(secret.as_str(), &mask(secret));
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    const TOKEN: &str = "f00dfeedcafe0123456789abcdef0123456789abcdef0123456789abcdef0123";

    // The cases of the project's test/redact.test.ts, and more.
    #[test]
    fn urls_lose_their_user_part() {
        assert_eq!(redact_url(&format!("go to http://{TOKEN}@192.0.2.1:12371/lock now")), "go to http://***@192.0.2.1:12371/lock now");
        assert_eq!(redact_url("http://u:p@h:1/x"), "http://***@h:1/x");
        assert_eq!(redact_url("http://h:1/x"), "http://h:1/x");
        assert_eq!(redact_url("HTTP://U@h"), "HTTP://***@h");
        assert_eq!(redact_url("xhttps+a.b-c://u@h x://@h y:// a@b z://a/b@c w://a@b@c"), "xhttps+a.b-c://***@h x://@h y:// a@b z://a/b@c w://***@b@c");
        assert_eq!(redact_url("é://u@h 1a://u@h a://u\u{a0}v@h a://ü@h"), "é://u@h 1a://***@h a://u\u{a0}v@h a://***@h");
        assert_eq!(redact_url("a://b://c@d"), "a://b://***@d");
    }

    #[test]
    fn secrets_are_masked_longest_first() {
        let secrets = vec![TOKEN.to_string()];
        assert_eq!(redact(&format!("Bearer {TOKEN} and http://{TOKEN}@192.0.2.1:12371"), &secrets), "Bearer f00d… and http://***@192.0.2.1:12371");
        let secrets = vec!["abcdefghij".to_string(), "abcdefgh".to_string()];
        assert_eq!(redact("abcdefghij abcdefgh", &secrets), "abcd… abcd…");
    }
}
