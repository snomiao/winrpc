//! yargs's `--help` of src/index.ts, as yargs 18 writes it, through
//! `console.log` and so through the redaction of src/redact.ts.
//!
//! The text depends on the environment, and only these states are taken:
//!
//! - standard output is not a terminal: yargs wraps at the terminal's width
//!   when it has one (and at 80 columns when it has not);
//! - yargs speaks English: the first of LC_ALL, LC_MESSAGES, LANG and
//!   LANGUAGE that is set and not empty, cut at the first `.` or `:`, is
//!   `C`, `POSIX`, `en` or `en_<anything>` (y18n then reads en.json, or no
//!   file at all), or none is set (yargs takes en_US);
//! - for the pages that show the defaults of `--host` and `--port` (the
//!   program's, which is `serve`'s, and `serve`'s and `tray`'s own): HOST
//!   unset or `0.0.0.0`, PORT unset or `12371`;
//! - `ahk-repl`'s page says whether WINRPC_URL is set (not empty).

use crate::args::Page;
use crate::client::Out;
use crate::machine::Machine;
use crate::{Answer, HandBack};

const ROOT: &[&str] = &[
    "winrpc",
    "",
    "Start the winrpc server",
    "",
    "Commands:",
    "  winrpc serve                  Start the winrpc server                [default]",
    "  winrpc ahk-repl [url]         Pipe stdin lines to a target winrpc server as",
    "                                AHK commands, print responses inline",
    "  winrpc lock [action] [lease]  UI lock / lease: show (default), or acquire |",
    "                                renew | release a lease that holds the UI across",
    "                                steps (JSON)",
    "  winrpc tray                   Show a system-tray icon tracking this host's",
    "                                winrpc server",
    "",
    "Options:",
    "  --version  Show version number                                       [boolean]",
    "  --help     Show help                                                 [boolean]",
    "  --host                                           [string] [default: \"0.0.0.0\"]",
    "  --port                                               [number] [default: 12371]",
];

const SERVE: &[&str] = &[
    "winrpc serve",
    "",
    "Start the winrpc server",
    "",
    "Options:",
    "  --version  Show version number                                       [boolean]",
    "  --help     Show help                                                 [boolean]",
    "  --host                                           [string] [default: \"0.0.0.0\"]",
    "  --port                                               [number] [default: 12371]",
];

const AHK_REPL_HEAD: &[&str] = &[
    "winrpc ahk-repl [url]",
    "",
    "Pipe stdin lines to a target winrpc server as AHK commands, print responses",
    "inline",
    "",
    "Positionals:",
];
const AHK_REPL_URL_UNSET: &str = "  url  Target winrpc URL (default $WINRPC_URL, unset)                   [string]";
const AHK_REPL_URL_SET: &str = "  url  Target winrpc URL (default $WINRPC_URL, set)                     [string]";
const AHK_REPL_TAIL: &[&str] = &[
    "",
    "Options:",
    "  --version  Show version number                                       [boolean]",
    "  --help     Show help                                                 [boolean]",
    "  --lease    UI lease id from `winrpc lock acquire` (default $WINRPC_LEASE)",
    "                                                                        [string]",
];

const LOCK: &[&str] = &[
    "winrpc lock [action] [lease]",
    "",
    "UI lock / lease: show (default), or acquire | renew | release a lease that holds",
    "the UI across steps (JSON)",
    "",
    "Positionals:",
    "  action",
    "     [string] [choices: \"show\", \"acquire\", \"renew\", \"release\"] [default: \"show\"]",
    "  lease   lease id for renew/release (default $WINRPC_LEASE)            [string]",
    "",
    "Options:",
    "  --version  Show version number                                       [boolean]",
    "  --help     Show help                                                 [boolean]",
    "  --url      Target winrpc URL (default $WINRPC_URL)                    [string]",
    "  --owner    acquire: who holds it (tool / flow name)                   [string]",
    "  --label    acquire: what the flow does                                [string]",
    "  --ttl      acquire/renew: seconds (capped at 600)                     [number]",
    "  --wait     acquire: seconds to wait for a running request (max 60, default 30)",
    "                                                                        [number]",
];

const TRAY: &[&str] = &[
    "winrpc tray",
    "",
    "Show a system-tray icon tracking this host's winrpc server",
    "",
    "Options:",
    "  --version  Show version number                                       [boolean]",
    "  --help     Show help                                                 [boolean]",
    "  --port                                               [number] [default: 12371]",
];

/// Whether yargs's strings are its English ones (see the module's comment).
fn english(machine: &Machine) -> bool {
    let chosen = ["LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"].iter().find_map(|name| machine.env.truthy(name));
    let Some(locale) = chosen else { return true };
    let locale = locale.split(['.', ':']).next().unwrap_or("");
    matches!(locale, "C" | "POSIX" | "en") || locale.starts_with("en_")
}

pub fn answer(page: Page, machine: &Machine) -> Result<Answer, HandBack> {
    if machine.stdout_tty || !english(machine) {
        return Err(HandBack);
    }
    let env = &machine.env;
    let default_host = || env.get("HOST").is_none_or(|host| host == "0.0.0.0");
    let default_port = || env.get("PORT").is_none_or(|port| port == "12371");
    let lines: Vec<&str> = match page {
        Page::Root | Page::Serve if !(default_host() && default_port()) => return Err(HandBack),
        Page::Tray if !default_port() => return Err(HandBack),
        Page::Root => ROOT.to_vec(),
        Page::Serve => SERVE.to_vec(),
        Page::Tray => TRAY.to_vec(),
        Page::Lock => LOCK.to_vec(),
        Page::AhkRepl => {
            let url = if env.truthy("WINRPC_URL").is_some() { AHK_REPL_URL_SET } else { AHK_REPL_URL_UNSET };
            let mut lines = AHK_REPL_HEAD.to_vec();
            lines.push(url);
            lines.extend_from_slice(AHK_REPL_TAIL);
            lines
        }
    };
    let mut out = Out::new(machine)?;
    out.log(&lines.join("\n"));
    Ok(out.exit(0))
}
