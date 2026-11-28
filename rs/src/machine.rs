//! Whether this machine is one on which the JavaScript would do exactly what
//! the ported commands do, decided before anything is printed or sent; and
//! `process.env` as the TypeScript sees it.
//!
//! "The JavaScript" is `bun src/index.ts` of the package, and before its
//! first line:
//!
//! - bun takes options and switches from variables named for it, Node and
//!   the libraries inside it (BUN_*, NODE_*, MIMALLOC_*, ICU_*), and the
//!   dynamic loader that starts bun reads LD_* (DYLD_* on macOS): any of
//!   them, except BUN_INSTALL, which bun's installer puts in every profile,
//!   hands back; so do yargs's own (YARGS_*);
//! - bun keeps the environment as text: a variable whose name or value is
//!   not UTF-8 hands back;
//! - bun reads `bunfig.toml` in the current directory, `~/.bunfig.toml` and
//!   `$XDG_CONFIG_HOME/.bunfig.toml`: any of them hands back;
//! - bun loads `.env` files of the current directory into the environment
//!   (rs/src/dotenv.rs): read as bun does, or handed back;
//! - bun reads package.json, tsconfig.json and jsconfig.json in the current
//!   directory and every directory above it, and may report on standard
//!   error what it does not like in them. bun 1.4.0 said nothing about a
//!   broken one in the cases tried here; a file is accepted all the same
//!   only in a shape codehost's port compared with bun 1.4.0
//!   (`plain_project_file`), and anything else hands back;
//! - bun cannot load a program from a path with `?` or `\` in it (Linux and
//!   macOS), so a package root with one hands back.
//!
//! And while it runs, bun prints `console.error` in red when standard output
//! or standard error is a terminal, or FORCE_COLOR is set. What would go to
//! standard error through `console.error` then hands back
//! (`Machine::plain_stderr`).

use std::ffi::OsStr;
use std::fs;
use std::io::{ErrorKind, IsTerminal};
use std::path::{Path, PathBuf};

use crate::dotenv;
use crate::json::{self, Json};
use crate::HandBack;

/// The systems the parity cases run on with the binary answering.
pub fn platform_is_proven() -> bool {
    cfg!(any(target_os = "linux", target_os = "macos", target_os = "windows"))
}

/// `process.env`: the real environment, and what bun added from `.env` files.
pub struct Env {
    added: Vec<(String, String)>,
    /// Whether the process's own environment is under `added` (always, but
    /// in tests).
    real: bool,
}

impl Env {
    pub fn get(&self, key: &str) -> Option<String> {
        if self.real {
            if let Some(value) = std::env::var_os(key) {
                // Checked to be UTF-8 in `Machine::read`.
                return value.into_string().ok();
            }
        }
        self.added.iter().find(|(k, _)| dotenv::same_name(k, key)).map(|(_, v)| v.clone())
    }

    /// `process.env[key]` is set and not empty.
    pub fn truthy(&self, key: &str) -> Option<String> {
        self.get(key).filter(|value| !value.is_empty())
    }

    /// These variables alone, for tests.
    #[cfg(test)]
    pub fn with(vars: &[(&str, &str)]) -> Env {
        Env { added: vars.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(), real: false }
    }
}

pub struct Machine {
    pub env: Env,
    pub stdout_tty: bool,
    /// Whether `console.error` would be coloured.
    coloured_stderr: bool,
}

impl Machine {
    /// `Ok` when what `console.error` writes comes out as plain text in the
    /// JavaScript too.
    pub fn plain_stderr(&self) -> Result<(), HandBack> {
        if self.coloured_stderr {
            Err(HandBack)
        } else {
            Ok(())
        }
    }

    pub fn read() -> Result<Machine, HandBack> {
        if std::env::vars_os().any(|(name, value)| for_the_runtime(&name) || name.to_str().is_none() || value.to_str().is_none()) {
            return Err(HandBack);
        }
        let root = crate::js_fallback::package_root().ok_or(HandBack)?;
        if cfg!(unix) && !loadable(&root) {
            return Err(HandBack);
        }
        let cwd = std::env::current_dir().map_err(|_| HandBack)?;
        cwd.to_str().ok_or(HandBack)?;

        let home_name = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
        let home = std::env::var_os(home_name).filter(|home| !home.is_empty()).ok_or(HandBack)?;
        absent(&cwd.join("bunfig.toml"))?;
        absent(&Path::new(&home).join(".bunfig.toml"))?;
        if let Some(config) = std::env::var_os("XDG_CONFIG_HOME").filter(|config| !config.is_empty()) {
            absent(&Path::new(&config).join(".bunfig.toml"))?;
        }
        for dir in cwd.ancestors() {
            for name in ["package.json", "tsconfig.json", "jsconfig.json"] {
                if let Some(content) = read_if_there(&dir.join(name))? {
                    if !plain_project_file(name, &content) {
                        return Err(HandBack);
                    }
                }
            }
        }

        let mut added: Vec<(String, String)> = Vec::new();
        for file in dotenv::FILES {
            for (key, value) in dotenv::read(&cwd.join(file))? {
                if std::env::var_os(&key).is_none() && added.iter().all(|(k, _)| !dotenv::same_name(k, &key)) {
                    added.push((key, value));
                }
            }
        }

        let stdout_tty = std::io::stdout().is_terminal();
        let terminal = stdout_tty || std::io::stderr().is_terminal();
        let coloured_stderr = terminal || std::env::var_os("FORCE_COLOR").is_some();
        Ok(Machine { env: Env { added, real: true }, stdout_tty, coloured_stderr })
    }

    /// Whether bun's `fetch` would go through a proxy (any of the variables
    /// it may read, in any case).
    pub fn proxy_set(&self) -> bool {
        std::env::vars_os().any(|(name, _)| {
            let name = name.to_string_lossy().to_ascii_uppercase();
            name.ends_with("_PROXY") || name == "NO_PROXY"
        })
    }
}

/// Variables bun, Node's compatibility layer, the allocator, ICU, the dynamic
/// loader that starts bun, or yargs read for themselves.
fn for_the_runtime(name: &OsStr) -> bool {
    let name = name.to_string_lossy().to_ascii_uppercase();
    name != "BUN_INSTALL" && ["BUN_", "NODE_", "MIMALLOC_", "ICU_", "LD_", "DYLD_", "YARGS_"].iter().any(|start| name.starts_with(start))
}

fn absent(path: &Path) -> Result<(), HandBack> {
    match fs::symlink_metadata(path) {
        Err(err) if matches!(err.kind(), ErrorKind::NotFound | ErrorKind::NotADirectory) => Ok(()),
        _ => Err(HandBack),
    }
}

/// The contents of a regular file, `None` when there is nothing at `path`,
/// `HandBack` for anything else there.
fn read_if_there(path: &Path) -> Result<Option<Vec<u8>>, HandBack> {
    match fs::metadata(path) {
        Err(err) if err.kind() == ErrorKind::NotFound => {
            absent(path)?;
            Ok(None)
        }
        Ok(meta) if meta.is_file() => fs::read(path).map(Some).map_err(|_| HandBack),
        _ => Err(HandBack),
    }
}

/// bun cannot load a program from a path with `?` or `\` in it (it takes the
/// one for a query and the other for a `/`).
fn loadable(path: &Path) -> bool {
    let real: PathBuf = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    ![path, real.as_path()].iter().any(|p| p.to_string_lossy().contains(['?', '\\']))
}

/// `exports`/`imports` targets: a path, or conditions (no key starting with
/// `.`) whose values are targets.
fn plain_target(value: &Json) -> bool {
    match value {
        Json::Str(_) => true,
        Json::Obj(members) => members.iter().all(|(key, value)| !key.starts_with('.') && plain_target(value)),
        _ => false,
    }
}

/// A `jsxFactory` bun reads without a word: ASCII identifiers joined by
/// single dots (`h`, `React.createElement`).
fn member_expression(text: &str) -> bool {
    text.split('.').all(|part| {
        let mut chars = part.chars();
        matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_' || c == '$') && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$')
    })
}

/// A package.json, tsconfig.json or jsconfig.json about which bun says
/// nothing, in shapes codehost's port compared with bun 1.4.0 (its
/// rs/src/runtime.rs). Shapes outside these go back.
pub fn plain_project_file(name: &str, content: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(content) else { return false };
    let Some(root @ Json::Obj(_)) = json::parse_file(text, true) else { return false };
    if name == "package.json" {
        let type_ok = match root.get("type") {
            None => true,
            Some(Json::Str(kind)) => kind == "module" || kind == "commonjs",
            Some(_) => false,
        };
        let exports_ok = match root.get("exports") {
            None | Some(Json::Str(_)) => true,
            Some(Json::Obj(members)) => {
                let subpaths = members.iter().filter(|(key, _)| key.starts_with('.')).count();
                (subpaths == 0 || subpaths == members.len()) && members.iter().all(|(_, value)| plain_target(value))
            }
            Some(_) => false,
        };
        let imports_ok = match root.get("imports") {
            None => true,
            Some(Json::Obj(members)) => members.iter().all(|(_, value)| plain_target(value)),
            Some(_) => false,
        };
        let browser_ok = match root.get("browser") {
            None | Some(Json::Str(_)) => true,
            Some(Json::Obj(members)) => members.iter().all(|(_, value)| matches!(value, Json::Str(_) | Json::Bool(_))),
            Some(_) => false,
        };
        type_ok && exports_ok && imports_ok && browser_ok
    } else {
        if root.get("extends").is_some() {
            return false;
        }
        match root.get("compilerOptions") {
            None => true,
            Some(options @ Json::Obj(_)) => {
                let base_url = matches!(options.get("baseUrl"), Some(Json::Str(base)) if !base.is_empty());
                let pattern = |text: &str| text.matches('*').count() <= 1;
                let target = |item: &Json| matches!(item, Json::Str(text) if pattern(text) && (base_url || text.starts_with("./") || text.starts_with("../")));
                let paths_ok = match options.get("paths") {
                    None => true,
                    Some(Json::Obj(members)) => members.iter().all(|(key, value)| pattern(key) && matches!(value, Json::Arr(items) if items.iter().all(target))),
                    Some(_) => false,
                };
                let jsx_ok = ["jsxFactory", "jsxFragmentFactory"].iter().all(|name| match options.get(name) {
                    None => true,
                    Some(Json::Str(text)) => member_expression(text),
                    Some(_) => false,
                });
                paths_ok && jsx_ok && options.get("importsNotUsedAsValues").is_none()
            }
            Some(_) => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plain(name: &str, text: &str) -> bool {
        plain_project_file(name, text.as_bytes())
    }

    // From codehost's port: what bun 1.4.0 said about each of these.
    #[test]
    fn project_files_bun_says_nothing_about() {
        for text in [
            r#"{"name": "x", "type": "module", "exports": {"./a": {"import": "./a.js", "default": "./b.js"}, "./package.json": "./package.json"}}"#,
            r#"{"exports": {"import": "./a.js", "require": "./b.cjs"}}"#,
            r##"{"exports": "x", "imports": {"#a": {"node": "./x.js"}}, "browser": {"./a": false, "b": "./c"}}"##,
            r#"{"main": 5, "module": {}, "sideEffects": [5], "workspaces": 5, "dependencies": {"a": 5}, "name": {}}"#,
            "// c\n{\"a\": 1,}",
        ] {
            assert!(plain("package.json", text), "{text}");
        }
        for text in [
            "// comment\n{\"compilerOptions\": {\"strict\": true, \"lib\": [\"es2020\",],},/* x */}",
            r#"{"compilerOptions": {"paths": {"@/*": ["./src/*"]}, "baseUrl": ".", "jsx": "weird"}}"#,
            r#"{"compilerOptions": {"paths": {}, "jsxFactory": "React.createElement", "jsxFragmentFactory": "h"}}"#,
        ] {
            assert!(plain("tsconfig.json", text), "{text}");
        }
    }

    #[test]
    fn project_files_bun_warns_about_or_not_compared() {
        for text in ["{bad", r#"{"a":1,"a":2}"#, r#"{"type": "weird"}"#, r#"{"exports": 5}"#, r#"{"exports": {".": "./a.js", "x": "./b.js"}}"#, "[]", "", "{'a': 1}"] {
            assert!(!plain("package.json", text), "{text}");
        }
        for text in [
            r#"{"compilerOptions": {"paths": {"a": 5}}}"#,
            r#"{"extends": "./x.json"}"#,
            r#"{"compilerOptions": {"paths": {"a*b*": ["./x"]}}}"#,
            r#"{"compilerOptions": {"paths": {"@/*": ["src/*"]}}}"#,
            r#"{"compilerOptions": {"jsxFactory": "a-b"}}"#,
        ] {
            assert!(!plain("tsconfig.json", text), "{text}");
            assert!(!plain("jsconfig.json", text), "{text}");
        }
    }

    #[test]
    fn variables_for_the_runtime() {
        for name in ["BUN_OPTIONS", "bun_config_verbose_fetch", "NODE_OPTIONS", "NODE_ENV", "MIMALLOC_VERBOSE", "ICU_DATA", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "YARGS_DISABLE_WRAP"] {
            assert!(for_the_runtime(OsStr::new(name)), "{name}");
        }
        for name in ["BUN_INSTALL", "WINRPC_URL", "HOME", "NODEJS", "LANG"] {
            assert!(!for_the_runtime(OsStr::new(name)), "{name}");
        }
    }
}
