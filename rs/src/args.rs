//! The command lines the binary answers itself, as yargs reads them
//! (src/index.ts: `.strict()`, `.help()`, the commands `serve` ($0),
//! `ahk-repl [url]`, `lock [action] [lease]` and `tray`).
//!
//! Only plain spellings are taken; everything else is `None` and goes back
//! to yargs, before anything has been done:
//!
//! - `--help` alone, or a command and `--help` (`winrpc lock --help`);
//! - `lock`, its positionals `action` (show, acquire, renew or release) and
//!   `lease`, and its options `--url`, `--owner`, `--label`, `--ttl` and
//!   `--wait`, each at most once, written `--name value` or `--name=value`
//!   with a value that is not empty and does not start with `-`; the two
//!   number options with a plain decimal number;
//! - `ahk-repl`, its positional `url` and its option `--lease`, likewise.
//!
//! Back to yargs: `serve` (and no command at all, which is `serve`), `tray`,
//! any other command, an option yargs knows but this does not (`--version`,
//! `--no-url`, `--url.x`, short flags), a repeated option, a third
//! positional, `--`, an empty word, and the word `help` anywhere (yargs
//! prints a help when it is the last word, and may read it elsewhere too).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Page {
    Root,
    Serve,
    AhkRepl,
    Lock,
    Tray,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Show,
    Acquire,
    Renew,
    Release,
}

impl Action {
    pub fn name(self) -> &'static str {
        match self {
            Action::Show => "show",
            Action::Acquire => "acquire",
            Action::Renew => "renew",
            Action::Release => "release",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Lock {
    pub action: Action,
    pub lease: Option<String>,
    pub url: Option<String>,
    pub owner: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AhkRepl {
    pub url: Option<String>,
    pub lease: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Invocation {
    Help(Page),
    Lock(Lock),
    AhkRepl(AhkRepl),
}

pub fn recognise(argv: &[String]) -> Option<Invocation> {
    let words: Vec<&str> = argv.iter().map(String::as_str).collect();
    match words.as_slice() {
        ["--help"] => Some(Invocation::Help(Page::Root)),
        [command, "--help"] => Some(Invocation::Help(match *command {
            "serve" => Page::Serve,
            "ahk-repl" => Page::AhkRepl,
            "lock" => Page::Lock,
            "tray" => Page::Tray,
            _ => return None,
        })),
        ["lock", rest @ ..] => lock(rest).map(Invocation::Lock),
        ["ahk-repl", rest @ ..] => ahk_repl(rest).map(Invocation::AhkRepl),
        _ => None,
    }
}

/// A value yargs takes as it is.
fn plain_value(value: &str) -> bool {
    !value.is_empty() && !value.starts_with('-') && value != "help"
}

/// What `--ttl` and `--wait` are given: digits, with a fraction maybe.
fn plain_number(value: &str) -> bool {
    let (whole, fraction) = value.split_once('.').unwrap_or((value, "0"));
    !whole.is_empty() && !fraction.is_empty() && whole.bytes().all(|b| b.is_ascii_digit()) && fraction.bytes().all(|b| b.is_ascii_digit())
}

struct Words<'a> {
    positionals: Vec<&'a str>,
    options: Vec<(&'a str, &'a str)>,
}

/// Splits the words after the command into positionals and options of the
/// given names, or `None` for anything else.
fn split<'a>(words: &[&'a str], names: &[&str], numbers: &[&str]) -> Option<Words<'a>> {
    let mut out = Words { positionals: Vec::new(), options: Vec::new() };
    let mut i = 0;
    while i < words.len() {
        let word = words[i];
        if word == "help" || word.is_empty() {
            return None;
        }
        if let Some(option) = word.strip_prefix("--") {
            let (name, value) = match option.split_once('=') {
                Some((name, value)) => (name, value),
                None => {
                    i += 1;
                    (option, *words.get(i)?)
                }
            };
            if !names.contains(&name) || !plain_value(value) || out.options.iter().any(|(n, _)| *n == name) {
                return None;
            }
            if numbers.contains(&name) && !plain_number(value) {
                return None;
            }
            out.options.push((name, value));
        } else if word.starts_with('-') {
            return None;
        } else {
            out.positionals.push(word);
        }
        i += 1;
    }
    Some(out)
}

impl Words<'_> {
    fn option(&self, name: &str) -> Option<String> {
        self.options.iter().find(|(n, _)| *n == name).map(|(_, v)| v.to_string())
    }
}

fn lock(words: &[&str]) -> Option<Lock> {
    let words = split(words, &["url", "owner", "label", "ttl", "wait"], &["ttl", "wait"])?;
    if words.positionals.len() > 2 {
        return None;
    }
    let action = match words.positionals.first().copied() {
        None | Some("show") => Action::Show,
        Some("acquire") => Action::Acquire,
        Some("renew") => Action::Renew,
        Some("release") => Action::Release,
        Some(_) => return None,
    };
    Some(Lock { action, lease: words.positionals.get(1).map(|s| s.to_string()), url: words.option("url"), owner: words.option("owner") })
}

fn ahk_repl(words: &[&str]) -> Option<AhkRepl> {
    let words = split(words, &["lease"], &[])?;
    if words.positionals.len() > 1 {
        return None;
    }
    Some(AhkRepl { url: words.positionals.first().map(|s| s.to_string()), lease: words.option("lease") })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(line: &str) -> Option<Invocation> {
        let argv: Vec<String> = line.split(' ').filter(|w| !w.is_empty()).map(String::from).collect();
        recognise(&argv)
    }

    fn lock_of(line: &str) -> Lock {
        match read(line) {
            Some(Invocation::Lock(lock)) => lock,
            other => panic!("{line}: {other:?}"),
        }
    }

    #[test]
    fn help_pages() {
        assert_eq!(read("--help"), Some(Invocation::Help(Page::Root)));
        assert_eq!(read("lock --help"), Some(Invocation::Help(Page::Lock)));
        assert_eq!(read("serve --help"), Some(Invocation::Help(Page::Serve)));
        for line in ["", "--help --help", "-h", "help", "lock help", "frob --help", "lock show --help", "--version", "serve", "tray", "--port 1"] {
            assert_eq!(read(line), None, "{line}");
        }
    }

    #[test]
    fn lock_lines() {
        assert_eq!(lock_of("lock"), Lock { action: Action::Show, lease: None, url: None, owner: None });
        assert_eq!(lock_of("lock --url=http://h:1/x?a=b show"), Lock { action: Action::Show, lease: None, url: Some("http://h:1/x?a=b".into()), owner: None });
        assert_eq!(lock_of("lock renew abc --ttl 30 --url u"), Lock { action: Action::Renew, lease: Some("abc".into()), url: Some("u".into()), owner: None });
        assert_eq!(lock_of("lock acquire --owner me --label x --wait 1.5").owner, Some("me".into()));
        for line in [
            "lock frob", "lock show a b", "lock --url", "lock --url --owner x", "lock --url=", "lock --url -x", "lock --url a --url b", "lock --bogus 1",
            "lock -u x", "lock --ttl abc", "lock --ttl -5", "lock --ttl 1e3", "lock --ttl .5", "lock --no-url", "lock --url.x 1", "lock -- show",
            "lock show help", "lock --url help", "lock --version",
        ] {
            assert_eq!(read(line), None, "{line}");
        }
    }

    #[test]
    fn ahk_repl_lines() {
        assert_eq!(read("ahk-repl"), Some(Invocation::AhkRepl(AhkRepl { url: None, lease: None })));
        assert_eq!(read("ahk-repl --lease=l u"), Some(Invocation::AhkRepl(AhkRepl { url: Some("u".into()), lease: Some("l".into()) })));
        for line in ["ahk-repl a b", "ahk-repl --url u", "ahk-repl --lease", "ahk-repl help"] {
            assert_eq!(read(line), None, "{line}");
        }
    }
}
