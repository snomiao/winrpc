//! winrpc — Rust entry point.
//!
//! Installed from npm, this binary is the command users run. A command runs
//! here once it has been ported and the parity cases (rs/parity.json) show
//! it behaves like the TypeScript; everything else is handed back to the
//! JavaScript the package still ships, src/index.ts, so nothing changes for
//! users.
//!
//! Native: `lock` / `lock show` against a server at an http URL
//! (rs/src/client.rs), what every client command says before it sends
//! anything (no URL, a URL that is not one, `lock acquire` without
//! `--owner`, `lock renew|release` without a lease), and the `--help` of the
//! program and of each command (rs/src/help.rs), on the systems
//! `machine::platform_is_proven` names. Each works out its whole answer
//! first and declines (`HandBack`) before any of it shows. `serve`, `tray`,
//! the requests that change something (`lock acquire|renew|release`,
//! `ahk-repl`) and every other command line go to the JavaScript.

mod args;
mod client;
mod dotenv;
mod help;
mod http;
mod js_fallback;
mod json;
mod machine;
mod redact;
mod url;

/// The package's JavaScript entry, relative to the package root.
const JS_ENTRY: &str = "src/index.ts";

/// `WINRPC_NO_NATIVE=1` hands every command back to the JavaScript: the way
/// out for a user if a ported command misbehaves.
fn native() -> bool {
    std::env::var_os("WINRPC_NO_NATIVE").is_none()
}

/// "Not mine": the invocation has to go to the JavaScript. Only ever
/// returned before the first output and before any request that changes
/// something.
pub use js_fallback::HandBack;

/// Everything a ported command prints, worked out before any of it is.
#[derive(Debug, Default)]
pub struct Answer {
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub code: i32,
}

fn main() {
    // Arguments that are not valid UTF-8 are for the JavaScript to deal with.
    let args: Option<Vec<String>> = std::env::args_os().skip(1).map(|arg| arg.into_string().ok()).collect();
    if let (Some(args), true) = (&args, native()) {
        // A panic before anything has been printed is a hand-back too: a bug
        // in a ported command must not cost the user their command.
        if let Some(answer) = js_fallback::attempt(|| answer(args)) {
            finish(answer);
        }
    }
    drop(args);
    js_fallback::run(JS_ENTRY)
}

fn answer(args: &[String]) -> Result<Answer, HandBack> {
    if !machine::platform_is_proven() {
        return Err(HandBack);
    }
    let invocation = args::recognise(args).ok_or(HandBack)?;
    let machine = machine::Machine::read()?;
    match invocation {
        args::Invocation::Help(page) => help::answer(page, &machine),
        args::Invocation::Lock(lock) => client::lock(&lock, &machine),
        args::Invocation::AhkRepl(repl) => client::ahk_repl(&repl, &machine),
    }
}

/// Prints and exits. A reader that has gone away is not an error, as it is
/// not for bun.
fn finish(answer: Answer) -> ! {
    use std::io::Write as _;

    let mut stderr = std::io::stderr().lock();
    let _ = stderr.write_all(&answer.stderr).and_then(|()| stderr.flush());
    drop(stderr);
    let mut stdout = std::io::stdout().lock();
    let _ = stdout.write_all(&answer.stdout).and_then(|()| stdout.flush());
    std::process::exit(answer.code)
}
