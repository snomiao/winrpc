//! JSON as the TypeScript reads and writes it, or "not sure".
//!
//! Two readers stand behind what the binary reads:
//!
//! - `JSON.parse`, of a server's answer (`parse_js`). `Err(Fail::Invalid)` is
//!   only for text that `JSON.parse` throws on as well (the TypeScript then
//!   goes on with `{}`); for valid JSON this reader cannot hold the way
//!   JavaScript does it is `Err(Fail::Unsure)`, and the caller hands back: a
//!   `\u` escape that is half of a surrogate pair, nesting deeper than 256;
//! - bun's own parser, of the package.json, tsconfig.json and jsconfig.json
//!   it reads before the program starts (`parse_file`). That one accepts a
//!   subset of what bun accepts, and `None` for everything else: a key given
//!   twice in an object, a byte order mark, and the rest of the list above.
//!   With `lenient`, comments (`//` to the end of the line, `/* */`) and a
//!   comma before `]` or `}` are accepted, as bun accepts them in those
//!   files; a `//` comment holding a carriage return or U+2028/U+2029 is not,
//!   since where bun ends such a line was not established. (From codehost's
//!   port, rs/src/json.rs, where it was compared with bun 1.4.0.)
//!
//! What the TypeScript prints of a parsed answer is `JSON.stringify(data,
//! null, 2)` (`stringify_js`), which takes the object model of JavaScript
//! (`members`): keys that are array indices come first, in ascending order,
//! then the others as written; a key given twice keeps the place of its first
//! appearance and the value of its last. Numbers are written as JavaScript
//! writes them only where that is certain: integers up to 2^53, and an
//! overflow (`1e400`, Infinity, written `null`). Any other number is
//! `Fail::Unsure`.

#[derive(Debug, Clone, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    /// The number as written.
    Num(String),
    Str(String),
    Arr(Vec<Json>),
    /// Members in the order written, every one of them, duplicates included.
    Obj(Vec<(String, Json)>),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fail {
    /// Not JSON: `JSON.parse` throws on it too.
    Invalid,
    /// JSON this reader does not hold as JavaScript does.
    Unsure,
}

const MAX_DEPTH: usize = 256;

/// `JSON.parse(text)`
pub fn parse_js(text: &str) -> Result<Json, Fail> {
    let mut reader = Reader { text: text.as_bytes(), at: 0, lenient: false, duplicates: true };
    reader.space()?;
    let value = reader.value(0)?;
    reader.space()?;
    if reader.at == reader.text.len() {
        Ok(value)
    } else {
        Err(Fail::Invalid)
    }
}

/// A package.json, tsconfig.json or jsconfig.json, when bun reads it as this
/// does (see the module's comment).
pub fn parse_file(text: &str, lenient: bool) -> Option<Json> {
    if text.starts_with('\u{feff}') {
        return None;
    }
    let mut reader = Reader { text: text.as_bytes(), at: 0, lenient, duplicates: false };
    reader.space().ok()?;
    let value = reader.value(0).ok()?;
    reader.space().ok()?;
    (reader.at == reader.text.len()).then_some(value)
}

struct Reader<'a> {
    text: &'a [u8],
    at: usize,
    lenient: bool,
    /// Whether a key may appear twice in an object (`JSON.parse` allows it).
    duplicates: bool,
}

type R<T> = Result<T, Fail>;

const INVALID: Fail = Fail::Invalid;

impl Reader<'_> {
    fn peek(&self) -> Option<u8> {
        self.text.get(self.at).copied()
    }

    fn eat(&mut self, byte: u8) -> bool {
        if self.peek() == Some(byte) {
            self.at += 1;
            true
        } else {
            false
        }
    }

    /// Whitespace as JSON has it (space, tab, CR, LF), and comments when lenient.
    fn space(&mut self) -> R<()> {
        loop {
            match self.peek() {
                Some(b' ' | b'\t' | b'\n' | b'\r') => self.at += 1,
                Some(b'/') if self.lenient => match self.text.get(self.at + 1) {
                    Some(b'/') => {
                        let end = self.text[self.at..].iter().position(|&b| b == b'\n').map_or(self.text.len(), |p| self.at + p);
                        let comment = std::str::from_utf8(&self.text[self.at..end]).map_err(|_| INVALID)?;
                        if comment.contains(['\r', '\u{2028}', '\u{2029}']) {
                            return Err(Fail::Unsure);
                        }
                        self.at = end;
                    }
                    Some(b'*') => {
                        let rest = &self.text[self.at + 2..];
                        let close = rest.windows(2).position(|w| w == b"*/").ok_or(INVALID)?;
                        self.at += 2 + close + 2;
                    }
                    _ => return Err(INVALID),
                },
                _ => return Ok(()),
            }
        }
    }

    fn value(&mut self, depth: usize) -> R<Json> {
        if depth > MAX_DEPTH {
            return Err(Fail::Unsure);
        }
        match self.peek().ok_or(INVALID)? {
            b'{' => {
                self.at += 1;
                let mut members: Vec<(String, Json)> = Vec::new();
                self.space()?;
                if self.eat(b'}') {
                    return Ok(Json::Obj(members));
                }
                loop {
                    if self.peek() != Some(b'"') {
                        return Err(INVALID);
                    }
                    let key = self.string()?;
                    if !self.duplicates && members.iter().any(|(k, _)| *k == key) {
                        return Err(Fail::Unsure);
                    }
                    self.space()?;
                    if !self.eat(b':') {
                        return Err(INVALID);
                    }
                    self.space()?;
                    let value = self.value(depth + 1)?;
                    members.push((key, value));
                    self.space()?;
                    if self.eat(b'}') {
                        return Ok(Json::Obj(members));
                    }
                    if !self.eat(b',') {
                        return Err(INVALID);
                    }
                    self.space()?;
                    if self.lenient && self.eat(b'}') {
                        return Ok(Json::Obj(members));
                    }
                }
            }
            b'[' => {
                self.at += 1;
                let mut items = Vec::new();
                self.space()?;
                if self.eat(b']') {
                    return Ok(Json::Arr(items));
                }
                loop {
                    items.push(self.value(depth + 1)?);
                    self.space()?;
                    if self.eat(b']') {
                        return Ok(Json::Arr(items));
                    }
                    if !self.eat(b',') {
                        return Err(INVALID);
                    }
                    self.space()?;
                    if self.lenient && self.eat(b']') {
                        return Ok(Json::Arr(items));
                    }
                }
            }
            b'"' => self.string().map(Json::Str),
            b't' => self.word("true", Json::Bool(true)),
            b'f' => self.word("false", Json::Bool(false)),
            b'n' => self.word("null", Json::Null),
            b'-' | b'0'..=b'9' => self.number(),
            _ => Err(INVALID),
        }
    }

    fn word(&mut self, word: &str, value: Json) -> R<Json> {
        if self.text[self.at..].starts_with(word.as_bytes()) {
            self.at += word.len();
            Ok(value)
        } else {
            Err(INVALID)
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.at;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.at += 1;
        }
        self.at - start
    }

    fn number(&mut self) -> R<Json> {
        let start = self.at;
        self.eat(b'-');
        match self.peek().ok_or(INVALID)? {
            b'0' => self.at += 1,
            b'1'..=b'9' => {
                self.digits();
            }
            _ => return Err(INVALID),
        }
        if self.eat(b'.') && self.digits() == 0 {
            return Err(INVALID);
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.at += 1;
            if !self.eat(b'+') {
                self.eat(b'-');
            }
            if self.digits() == 0 {
                return Err(INVALID);
            }
        }
        // Only ASCII was taken.
        let text = std::str::from_utf8(&self.text[start..self.at]).map_err(|_| INVALID)?;
        Ok(Json::Num(text.to_string()))
    }

    fn hex4(&mut self) -> R<u32> {
        let digits = self.text.get(self.at..self.at + 4).ok_or(INVALID)?;
        if !digits.iter().all(u8::is_ascii_hexdigit) {
            return Err(INVALID);
        }
        self.at += 4;
        // Four hex digits are ASCII.
        u32::from_str_radix(std::str::from_utf8(digits).map_err(|_| INVALID)?, 16).map_err(|_| INVALID)
    }

    fn string(&mut self) -> R<String> {
        self.at += 1; // the opening quote
        let mut out = String::new();
        loop {
            let start = self.at;
            while let Some(b) = self.peek() {
                if b == b'"' || b == b'\\' || b < 0x20 {
                    break;
                }
                self.at += 1;
            }
            // The text came in as a str and was cut at ASCII bytes only.
            out.push_str(std::str::from_utf8(&self.text[start..self.at]).map_err(|_| INVALID)?);
            match self.peek().ok_or(INVALID)? {
                b'"' => {
                    self.at += 1;
                    return Ok(out);
                }
                b'\\' => {
                    self.at += 1;
                    let escaped = self.peek().ok_or(INVALID)?;
                    self.at += 1;
                    match escaped {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let unit = self.hex4()?;
                            let code = match unit {
                                0xd800..=0xdbff => {
                                    // Valid JSON either way; only a pair is a
                                    // character a Rust string can hold.
                                    // (Unsure only ever hands back, so it may
                                    // also stand for text that is invalid
                                    // further on.)
                                    if !(self.eat(b'\\') && self.eat(b'u')) {
                                        return Err(Fail::Unsure);
                                    }
                                    let low = self.hex4()?;
                                    if !(0xdc00..=0xdfff).contains(&low) {
                                        return Err(Fail::Unsure);
                                    }
                                    0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00)
                                }
                                0xdc00..=0xdfff => return Err(Fail::Unsure),
                                _ => unit,
                            };
                            out.push(char::from_u32(code).ok_or(INVALID)?);
                        }
                        _ => return Err(INVALID),
                    }
                }
                // A control character: not allowed unescaped.
                _ => return Err(INVALID),
            }
        }
    }
}

/// Whether `key` is an array index (a canonical integer from 0 to 2^32 - 2),
/// which JavaScript keeps ahead of the other keys of an object.
fn is_array_index(key: &str) -> bool {
    if key == "0" {
        return true;
    }
    key.len() <= 10 && key.starts_with(|c: char| ('1'..='9').contains(&c)) && key.bytes().all(|b| b.is_ascii_digit()) && key.parse::<u64>().is_ok_and(|n| n <= 4_294_967_294)
}

/// The members of an object as JavaScript holds it after `JSON.parse`: the
/// last value of each key, in the place the key first had, array indices
/// first in ascending order.
pub fn members(written: &[(String, Json)]) -> Vec<(&str, &Json)> {
    let mut out: Vec<(&str, &Json)> = Vec::new();
    for (key, value) in written {
        match out.iter_mut().find(|(k, _)| *k == key.as_str()) {
            Some(member) => member.1 = value,
            None => out.push((key.as_str(), value)),
        }
    }
    let (mut indices, names): (Vec<_>, Vec<_>) = out.into_iter().partition(|(key, _)| is_array_index(key));
    indices.sort_by_key(|(key, _)| key.parse::<u64>().unwrap_or(0));
    indices.extend(names);
    indices
}

impl Json {
    /// `value[key]` for an object; `None` for a key it does not have, and for
    /// anything that is not an object (a JSON array or string has no such
    /// property either: the names asked for are not `length` or an index).
    pub fn get(&self, key: &str) -> Option<&Json> {
        match self {
            Json::Obj(written) => written.iter().rev().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// Whether `value` is truthy in JavaScript.
    pub fn truthy(&self) -> Result<bool, Fail> {
        Ok(match self {
            Json::Null => false,
            Json::Bool(b) => *b,
            Json::Num(_) => {
                let n = number(self)?;
                n != 0.0
            }
            Json::Str(s) => !s.is_empty(),
            Json::Arr(_) | Json::Obj(_) => true,
        })
    }

    /// `String(value)`, or Unsure where JavaScript would throw (an object
    /// with a key `toString`: its value is no function, and `valueOf` gives
    /// the object back) or where the number is not one written for sure.
    pub fn to_js_string(&self) -> Result<String, Fail> {
        match self {
            Json::Null => Ok("null".into()),
            Json::Bool(b) => Ok(b.to_string()),
            Json::Num(_) => number_to_string(number(self)?, "Infinity"),
            Json::Str(s) => Ok(s.clone()),
            // Array.prototype.join: null and undefined become nothing.
            Json::Arr(items) => {
                let mut parts = Vec::new();
                for item in items {
                    parts.push(match item {
                        Json::Null => String::new(),
                        other => other.to_js_string()?,
                    });
                }
                Ok(parts.join(","))
            }
            Json::Obj(written) => {
                if written.iter().any(|(k, _)| k == "toString") {
                    Err(Fail::Unsure)
                } else {
                    Ok("[object Object]".into())
                }
            }
        }
    }
}

fn number(value: &Json) -> Result<f64, Fail> {
    match value {
        // Rust's parse rounds correctly, as JavaScript does.
        Json::Num(text) => text.parse::<f64>().map_err(|_| Fail::Unsure),
        _ => Err(Fail::Unsure),
    }
}

/// How JavaScript writes `n`, where that is certain: an integer up to 2^53
/// (-0 is `0`), or an infinity (`infinite`, signed).
fn number_to_string(n: f64, infinite: &str) -> Result<String, Fail> {
    const LIMIT: f64 = 9_007_199_254_740_992.0; // 2^53
    if n.is_infinite() {
        return Ok(if n < 0.0 && infinite != "null" { format!("-{infinite}") } else { infinite.to_string() });
    }
    if n.fract() == 0.0 && n.abs() <= LIMIT {
        // Exact: every integer up to 2^53 is a double, and an i64.
        return Ok(format!("{}", n as i64));
    }
    Err(Fail::Unsure)
}

/// `JSON.stringify(text)`
pub fn stringify_str(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// `JSON.stringify(value, null, 2)`
pub fn stringify_js(value: &Json) -> Result<String, Fail> {
    let mut out = String::new();
    write_value(value, 0, &mut out)?;
    Ok(out)
}

fn indent(out: &mut String, level: usize) {
    out.push('\n');
    for _ in 0..level {
        out.push_str("  ");
    }
}

fn write_value(value: &Json, level: usize, out: &mut String) -> Result<(), Fail> {
    match value {
        Json::Null => out.push_str("null"),
        Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Json::Num(_) => out.push_str(&number_to_string(number(value)?, "null")?),
        Json::Str(s) => out.push_str(&stringify_str(s)),
        Json::Arr(items) => {
            if items.is_empty() {
                out.push_str("[]");
                return Ok(());
            }
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                indent(out, level + 1);
                write_value(item, level + 1, out)?;
            }
            indent(out, level);
            out.push(']');
        }
        Json::Obj(written) => {
            let members = members(written);
            if members.is_empty() {
                out.push_str("{}");
                return Ok(());
            }
            out.push('{');
            for (i, (key, item)) in members.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                indent(out, level + 1);
                out.push_str(&stringify_str(key));
                out.push_str(": ");
                write_value(item, level + 1, out)?;
            }
            indent(out, level);
            out.push('}');
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn obj(pairs: &[(&str, Json)]) -> Json {
        Json::Obj(pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect())
    }

    fn pretty(text: &str) -> Result<String, Fail> {
        stringify_js(&parse_js(text)?)
    }

    #[test]
    fn reads_plain_json() {
        assert_eq!(
            parse_js(r#" {"a": [1, -2.5e3, true, null], "b": "x\u00e9\ud83d\ude00\n"} "#),
            Ok(obj(&[
                ("a", Json::Arr(vec![Json::Num("1".into()), Json::Num("-2.5e3".into()), Json::Bool(true), Json::Null])),
                ("b", Json::Str("xé😀\n".into())),
            ]))
        );
    }

    #[test]
    fn what_json_parse_throws_on_is_invalid() {
        for text in [
            "", " ", "\u{feff}{}", "01", "1.", ".5", "+1", "0x10", "'a'", "{a:1}", "[1,]", "{\"a\":1,}", "// c\n{}", "\"a\tb\"", "NaN",
            "[1 2]", "{} {}", "\"\\x\"", "tru", "nul", "[", "{\"a\"}", "\"\\ud800\\u12\"", "Unauthorized — include",
            "<html>", "-", "1e", "1e+", "\"\\u00\"", "[1,,2]", "\u{a0}1",
        ] {
            assert_eq!(parse_js(text), Err(Fail::Invalid), "{text:?}");
        }
    }

    #[test]
    fn valid_json_it_cannot_hold_is_unsure() {
        for text in ["\"\\ud800\"", "\"\\ud800", "\"\\udc00\"", "[\"\\ud800x\", 1]", "\"\\ud800\\u0041\"", &"[".repeat(300)] {
            let text = if text.starts_with("[[") { format!("{text}{}", "]".repeat(300)) } else { text.to_string() };
            assert_eq!(parse_js(&text), Err(Fail::Unsure), "{text:?}");
        }
    }

    #[test]
    fn writes_as_json_stringify_with_two_spaces() {
        assert_eq!(pretty("{}"), Ok("{}".into()));
        assert_eq!(pretty("[]"), Ok("[]".into()));
        assert_eq!(pretty("{\"a\":[],\"b\":{}}"), Ok("{\n  \"a\": [],\n  \"b\": {}\n}".into()));
        assert_eq!(pretty("[1,[2,{\"x\":null}]]"), Ok("[\n  1,\n  [\n    2,\n    {\n      \"x\": null\n    }\n  ]\n]".into()));
        assert_eq!(pretty("\"x\""), Ok("\"x\"".into()));
        assert_eq!(pretty("null"), Ok("null".into()));
        assert_eq!(pretty("-0"), Ok("0".into()));
        assert_eq!(pretty("1.0"), Ok("1".into()));
        assert_eq!(pretty("1e3"), Ok("1000".into()));
        assert_eq!(pretty("9007199254740992"), Ok("9007199254740992".into()));
        // Read as the nearest double, as JSON.parse reads it.
        assert_eq!(pretty("9007199254740993"), Ok("9007199254740992".into()));
        assert_eq!(pretty("1e400"), Ok("null".into()));
        assert_eq!(pretty("-1e400"), Ok("null".into()));
        for text in ["2.5", "9007199254740994", "1e21", "0.1", "1e-7"] {
            assert_eq!(pretty(text), Err(Fail::Unsure), "{text}");
        }
    }

    #[test]
    fn keeps_the_order_of_a_javascript_object() {
        assert_eq!(pretty("{\"b\":1,\"a\":2,\"1\":3,\"0\":4,\"01\":5,\"-1\":6,\"4294967295\":7,\"4294967294\":8}"), Ok(
            "{\n  \"0\": 4,\n  \"1\": 3,\n  \"4294967294\": 8,\n  \"b\": 1,\n  \"a\": 2,\n  \"01\": 5,\n  \"-1\": 6,\n  \"4294967295\": 7\n}".into()
        ));
        assert_eq!(pretty("{\"b\":1,\"a\":2,\"b\":3}"), Ok("{\n  \"b\": 3,\n  \"a\": 2\n}".into()));
        assert_eq!(pretty("{\"__proto__\":1}"), Ok("{\n  \"__proto__\": 1\n}".into()));
    }

    #[test]
    fn strings_as_javascript_converts_them() {
        let value = |text: &str| parse_js(text).unwrap();
        assert_eq!(value("\"a\"").to_js_string(), Ok("a".into()));
        assert_eq!(value("12").to_js_string(), Ok("12".into()));
        assert_eq!(value("1e400").to_js_string(), Ok("Infinity".into()));
        assert_eq!(value("-1e400").to_js_string(), Ok("-Infinity".into()));
        assert_eq!(value("true").to_js_string(), Ok("true".into()));
        assert_eq!(value("{}").to_js_string(), Ok("[object Object]".into()));
        assert_eq!(value("{\"valueOf\":1}").to_js_string(), Ok("[object Object]".into()));
        assert_eq!(value("[1,null,\"a\",[2,3],{}]").to_js_string(), Ok("1,,a,2,3,[object Object]".into()));
        assert_eq!(value("{\"toString\":1}").to_js_string(), Err(Fail::Unsure));
        assert_eq!(value("[{\"toString\":1}]").to_js_string(), Err(Fail::Unsure));
        assert_eq!(value("1.5").to_js_string(), Err(Fail::Unsure));
        for (text, truthy) in [("0", false), ("-0", false), ("0.0", false), ("1", true), ("\"\"", false), ("\"0\"", true), ("null", false), ("false", false), ("[]", true), ("{}", true)] {
            assert_eq!(value(text).truthy(), Ok(truthy), "{text}");
        }
    }

    #[test]
    fn files_decline_what_bun_may_read_otherwise() {
        for text in ["", "\u{feff}{}", "{\"a\":1,\"a\":2}", "{\"x\":{\"a\":1,\"a\":2}}", "\"\\ud800\"", "01", "[1,]", "{\"a\":1,}", "// c\n{}"] {
            assert_eq!(parse_file(text, false), None, "{text:?}");
        }
        for text in ["[1,,]", "[,]", "{,}", "// a\r{}", "/* open {}", "{'a':1}", "{\"a\":1,\"a\":2}"] {
            assert_eq!(parse_file(text, true), None, "{text:?}");
        }
        assert_eq!(parse_file("// c\n{\"a\": [1,],} /* end */", true), Some(obj(&[("a", Json::Arr(vec![Json::Num("1".into())]))])));
    }

    #[test]
    fn stringifies_like_json_stringify() {
        assert_eq!(stringify_str("a\"\\\u{1}\u{1f}\n\u{2028}é\u{7f}/"), "\"a\\\"\\\\\\u0001\\u001f\\n\u{2028}é\u{7f}/\"");
    }
}
