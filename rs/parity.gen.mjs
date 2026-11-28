#!/usr/bin/env node
// Writes rs/parity.json, the parity cases of the Rust port of winrpc, for
// rustify's runner (templates/parity/parity.mjs). `--check` fails instead
// when the committed file is not what this writes.
//
//   node rs/parity.gen.mjs [--check]
//
// Every case runs behind rs/parity/with-mock.mjs, which starts a stand-in
// for a winrpc server on 127.0.0.1 (WINRPC_PARITY_MOCK says what it
// answers), puts its address where a case says MOCKHOST (its port for
// MOCKPORT), and writes down what it was asked (<ROOT>/requests.log, which
// the `after` line of a case prints). No case reaches a real server, runs
// AutoHotkey or PowerShell, or starts `winrpc serve` or `winrpc tray`.
//
// A case marked "handback" is meant to reach the JavaScript (on every
// system, or on those it names); the others are answered by the binary.
// A case whose binary hands a GET back after making it is asked twice: its
// log is compared as `sort -u`, which says which requests were made, not
// how many.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "parity.json");

const cases = [];
const LOG = "cat <ROOT>/requests.log";
const LOG_ONCE_OR_TWICE = "sort -u <ROOT>/requests.log";
// What the JavaScript prints of these names the stand-in's address, which
// rs/parity/with-mock.mjs puts back as MOCKHOST only in what goes through
// a pipe: they keep pipes in the run with --tty stdout,stderr too.
const ADDRESS_SHOWN = false;
const NO_TTY_ON_WINDOWS = { win32: "no terminal on Windows (the runner's pseudo-terminal needs Linux or macOS)" };

function add(name, args, o = {}) {
  if (cases.some((c) => c.name === name)) throw new Error(`two cases named ${name}`);
  const c = { name, args };
  if (o.mock) c.env = { ...(c.env || {}), WINRPC_PARITY_MOCK: JSON.stringify(o.mock) };
  if (o.env) c.env = { ...(c.env || {}), ...o.env };
  for (const key of ["stdin", "files", "setup", "tty", "skip", "timeout"]) if (o[key] !== undefined) c[key] = o[key];
  c.after = o.after ?? [o.twice ? LOG_ONCE_OR_TWICE : LOG];
  if (o.back) c.handback = o.back;
  cases.push(c);
  return c;
}

// ═══════════════════════════ what a winrpc server answers ═══════════════════════════
//
// The shapes of src/server.ts: GET /lock, /lock/acquire, the 401 of
// src/auth.ts, a route's error as onError writes it.

const FAKE = "fake-token-0123456789abcdef";
const UNLOCKED = { locked: false, lease: null };
const LEASED = {
  locked: true, holder: "lease:flow-a", pid: 4242, host: "WINBOX", expiresIn: 119873,
  lease: { owner: "flow-a", label: "file picker", acquired_at: "2026-11-27T10:00:00.000Z", expires_at: "2026-11-27T10:02:00.000Z" },
};
const BUSY = { locked: true, holder: "ahk-eval", pid: 4242, host: "WINBOX", expiresIn: 59000, lease: null };
const UNAUTHORIZED = { status: 401, body: "Unauthorized — include access token in URL: http://<token>@host:port", headers: [["Content-Type", "text/plain;charset=utf-8"], ["WWW-Authenticate", 'Basic realm="winrpc"']] };
const HELD = { ok: false, error: "ui lease held", holder: "flow-a", label: "file picker", expires_at: "2026-11-27T10:02:00.000Z" };
const GONE = { ok: false, error: "no such lease (expired or released)" };
const lockAnswer = (reply) => ({ routes: { "GET /lock": reply } });
const ok = (json) => lockAnswer({ status: 200, json });
const URL = "http://MOCKHOST";
const TOKEN_URL = `http://${FAKE}@MOCKHOST`;

// ═══════════════════════════ --help ═══════════════════════════

for (const args of [["--help"], ["serve", "--help"], ["lock", "--help"], ["ahk-repl", "--help"], ["tray", "--help"]]) {
  add(`help: ${args.join(" ")}`, args);
}
add("help: ahk-repl --help says WINRPC_URL is set", ["ahk-repl", "--help"], { env: { WINRPC_URL: `http://${FAKE}@127.0.0.1:9` } });
add("help: ahk-repl --help, WINRPC_URL empty is unset", ["ahk-repl", "--help"], { env: { WINRPC_URL: "" } });
add("help: ahk-repl --help, WINRPC_URL from .env.local", ["ahk-repl", "--help"], { files: { ".env.local": `WINRPC_URL=http://${FAKE}@127.0.0.1:9\n` } });
add("help: a token that is a word of the help is masked in it", ["--help"], { env: { WINRPC_TOKEN: "Commands" } });
add("help: a token of seven characters is not masked", ["--help"], { env: { WINRPC_TOKEN: "Options" } });
add("help: the password of WINRPC_URL is masked in it", ["lock", "--help"], { env: { WINRPC_URL: "http://who:Positionals@127.0.0.1:9" } });
add("help: a token padded with spaces is masked trimmed", ["tray", "--help"], { env: { WINRPC_TOKEN: "  system-tray \t" } });
for (const [what, env, back] of [
  ["LANG=en_US.UTF-8", { LANG: "en_US.UTF-8" }],
  ["LANG=en_GB.UTF-8", { LANG: "en_GB.UTF-8" }],
  ["LANG=C.UTF-8", { LANG: "C.UTF-8" }],
  ["LC_ALL=POSIX", { LC_ALL: "POSIX", LANG: "de_DE.UTF-8" }],
  ["LC_MESSAGES=en and LANG=fr_FR", { LC_MESSAGES: "en", LANG: "fr_FR.UTF-8" }],
  ["an empty LC_ALL, LANG=en_US", { LC_ALL: "", LANG: "en_US.UTF-8" }],
  ["LANGUAGE=en_US:de", { LANGUAGE: "en_US:de" }],
  ["LANG=de_DE.UTF-8", { LANG: "de_DE.UTF-8" }, "yargs speaks German (its locales/de.json)"],
  ["LC_ALL=ja_JP.UTF-8 over LANG=en_US", { LC_ALL: "ja_JP.UTF-8", LANG: "en_US.UTF-8" }, "yargs speaks Japanese"],
  ["LANGUAGE=fr", { LANGUAGE: "fr" }, "yargs speaks French"],
  ["LC_MESSAGES=pirate", { LC_MESSAGES: "pirate" }, "yargs speaks pirate"],
  ["LANG=xx_YY", { LANG: "xx_YY" }, "a locale yargs has no file for is not imitated"],
]) {
  add(`help: --help with ${what}`, ["--help"], { env, back });
  if (!back) add(`help: lock --help with ${what}`, ["lock", "--help"], { env });
}
add("help: --help with HOST=0.0.0.0 and PORT=12371", ["--help"], { env: { HOST: "0.0.0.0", PORT: "12371" } });
add("help: --help with HOST set", ["--help"], { env: { HOST: "127.0.0.1" }, back: "the default of --host comes from HOST" });
add("help: serve --help with PORT set", ["serve", "--help"], { env: { PORT: "8080" }, back: "the default of --port comes from PORT" });
add("help: tray --help with PORT not a number", ["tray", "--help"], { env: { PORT: "x" }, back: "the default of --port comes from PORT (NaN)" });
add("help: tray --help with HOST set", ["tray", "--help"], { env: { HOST: "127.0.0.1" } });
add("help: lock --help with HOST and PORT set", ["lock", "--help"], { env: { HOST: "127.0.0.1", PORT: "8080" } });
add("help: --help with HOST in .env", ["--help"], { files: { ".env": "HOST=127.0.0.1\n" }, back: "the default of --host comes from HOST" });
add("help: YARGS_DISABLE_WRAP", ["--help"], { env: { YARGS_DISABLE_WRAP: "1" }, back: "yargs does not wrap" });
add("help: stdout is a terminal", ["--help"], { tty: "stdout", skip: NO_TTY_ON_WINDOWS, back: "yargs wraps at the terminal's width" });
add("help: stderr is a terminal", ["lock", "--help"], { tty: "stderr", skip: NO_TTY_ON_WINDOWS });
for (const [what, args] of [
  ["-h", ["-h"]],
  ["help", ["help"]],
  ["lock help", ["lock", "help"]],
  ["lock show --help", ["lock", "show", "--help"]],
  ["--help twice", ["--help", "--help"]],
  ["--version", ["--version"]],
  ["--help of an unknown command", ["frobnicate", "--help"]],
]) {
  add(`help: ${what}`, args, { back: "yargs's own reading of the command line" });
}

// ═══════════════════════════ what bun does before the program ═══════════════════════════

for (const [what, o, back] of [
  ["BUN_OPTIONS", { env: { BUN_OPTIONS: "--no-env-file" } }, "BUN_OPTIONS changes how bun starts"],
  ["NODE_OPTIONS", { env: { NODE_OPTIONS: "--no-warnings" } }, "NODE_OPTIONS changes how bun starts"],
  ["NODE_ENV", { env: { NODE_ENV: "production" } }, "NODE_ENV changes which .env files bun reads"],
  ["bunfig.toml here", { files: { "bunfig.toml": "telemetry = false\n" } }, "bunfig.toml changes what bun does before the program starts"],
  ["~/.bunfig.toml", { setup: ["echo 'telemetry = false' > <HOME>/.bunfig.toml"] }, "bunfig.toml changes what bun does before the program starts"],
  ["a package.json bun may complain about", { files: { "package.json": "{bad" } }, "a package.json in a shape not compared with bun"],
  ["a tsconfig.json with extends", { files: { "tsconfig.json": '{"extends": "./base.json"}' } }, "a tsconfig.json in a shape not compared with bun"],
  ["a plain package.json", { files: { "package.json": '{"name": "x", "type": "module"}\n' } }],
  ["a plain tsconfig.json with comments", { files: { "tsconfig.json": '// c\n{"compilerOptions": {"strict": true,},}\n' } }],
  ["a package.json above the directory", { setup: ["echo '{bad' > ../package.json"] }, "a package.json in a shape not compared with bun"],
]) {
  add(`bun: --help with ${what}`, ["--help"], { ...o, back });
}

// ═══════════════════════════ lock show ═══════════════════════════

add("lock: unlocked", ["lock", "--url", URL], { mock: ok(UNLOCKED) });
add("lock show: held by a lease", ["lock", "show", `--url=${URL}/`], { mock: ok(LEASED) });
add("lock: held by a running request", ["lock", "--url", URL, "show"], { mock: ok(BUSY) });
add("lock: the token in the URL is sent as a Bearer token", ["lock", "--url", TOKEN_URL], { mock: ok(UNLOCKED) });
add("lock: WINRPC_TOKEN is sent when the URL has none", ["lock", "--url", URL], { mock: ok(UNLOCKED), env: { WINRPC_TOKEN: `${FAKE}-env` } });
add("lock: WINRPC_TOKEN is sent untrimmed inside", ["lock", "--url", URL], { mock: ok(UNLOCKED), env: { WINRPC_TOKEN: "fake token with spaces" } });
add("lock: the URL's token wins over WINRPC_TOKEN", ["lock", "--url", TOKEN_URL], { mock: ok(UNLOCKED), env: { WINRPC_TOKEN: "fake-other-token-value" } });
add("lock: a password in the URL is not sent", ["lock", "--url", `http://${FAKE}:fake-password@MOCKHOST`], { mock: ok(UNLOCKED) });
add("lock: a password alone in the URL, WINRPC_TOKEN sent", ["lock", "--url", "http://:fake-password@MOCKHOST"], { mock: ok(UNLOCKED), env: { WINRPC_TOKEN: FAKE } });
add("lock: an empty user part", ["lock", "--url", "http://@MOCKHOST"], { mock: ok(UNLOCKED) });
add("lock: WINRPC_URL", ["lock"], { mock: ok(LEASED), env: { WINRPC_URL: TOKEN_URL } });
add("lock: --url wins over WINRPC_URL", ["lock", "--url", URL], { mock: ok(UNLOCKED), env: { WINRPC_URL: "http://fake-not-this@127.0.0.1:9" } });
add("lock: WINRPC_LEASE is sent", ["lock", "--url", TOKEN_URL], { mock: ok(LEASED), env: { WINRPC_LEASE: "0123456789abcdef0123456789abcdef" } });
add("lock: an empty WINRPC_LEASE is not sent", ["lock", "--url", TOKEN_URL], { mock: ok(UNLOCKED), env: { WINRPC_LEASE: "" } });
add("lock show: a lease argument is not sent", ["lock", "show", "my-lease", "--url", URL], { mock: ok(UNLOCKED) });
add("lock: options of acquire are taken and not used", ["lock", "--url", URL, "--owner", "me", "--label", "x", "--ttl", "30", "--wait=1.5"], { mock: ok(UNLOCKED) });
add("lock: a path in the URL", ["lock", "--url", "http://MOCKHOST/winrpc/"], { mock: { routes: { "GET /winrpc/lock": { status: 200, json: UNLOCKED } } } });
add("lock: a path in the URL without a slash at the end", ["lock", "--url", "http://MOCKHOST/a/b"], { mock: { routes: { "GET /a/b/lock": { status: 200, json: UNLOCKED } } } });
add("lock: two slashes at the end", ["lock", "--url", "http://MOCKHOST//"], { mock: { routes: { "GET //lock": { status: 200, json: UNLOCKED }, "GET /lock": { status: 200, json: BUSY } } }, back: "bun's fetch asks for /lock where the URL says //lock" });
add("lock: two slashes inside the path", ["lock", "--url", "http://MOCKHOST/a//b"], { mock: { routes: { "GET /a//b/lock": { status: 200, json: UNLOCKED } } }, back: "an empty path segment is not imitated" });
add("lock: upper-case scheme and host", ["lock", "--url", "HTTP://LOCALHOST:MOCKPORT"], { mock: ok(UNLOCKED) });
add("lock: localhost", ["lock", "--url", `http://${FAKE}@localhost:MOCKPORT/`], { mock: ok(UNLOCKED) });
add("lock: a port with leading zeros", ["lock", "--url", "http://127.0.0.1:0MOCKPORT"], { mock: ok(UNLOCKED) });
add("lock: localhost, the server on ::1 only", ["lock", "--url", "http://localhost:MOCKPORT"], { mock: { ...ok(UNLOCKED), listen: "::1" }, tty: ADDRESS_SHOWN });
add("lock: no server", ["lock", "--url", "http://127.0.0.1:9"]);
add("lock: no server, the URL's token masked", ["lock", "--url", `http://${FAKE}@127.0.0.1:9`]);
add("lock: no server, WINRPC_URL", ["lock"], { env: { WINRPC_URL: `http://${FAKE}@localhost:9/x/` } });

// The answers, as the client prints them. An answer that is not ok goes to
// console.error, which bun colours on a terminal: there (in the run with
// --tty stdout,stderr) the binary hands it back after its GET, and the
// server is asked twice. Those cases compare which requests were made.
const notOk = (name, args, mock, o = {}) => add(name, args, { mock, twice: true, ...o });
notOk("lock: 401", ["lock", "--url", URL], lockAnswer(UNAUTHORIZED));
notOk("lock: 404 of another server", ["lock", "--url", URL], lockAnswer({ status: 404, body: "<html><body>Not Found</body></html>\n", headers: [["Content-Type", "text/html"]] }));
notOk("lock: 410 with JSON", ["lock", "--url", URL], lockAnswer({ status: 410, json: GONE }));
notOk("lock: a reason phrase of its own", ["lock", "--url", URL], lockAnswer({ status: 503, reason: "Back Soon, Maybe", body: "{\"ok\":false}" }));
notOk("lock: 500 as onError writes it", ["lock", "--url", URL], lockAnswer({ status: 500, json: { ok: false, stdout: "", stderr: "boom", exitCode: 1 } }));
notOk("lock: 400 with an empty body", ["lock", "--url", URL], lockAnswer({ status: 400, body: "" }));
notOk("lock: 599", ["lock", "--url", URL], lockAnswer({ status: 599, reason: "Odd", body: "x" }));
add("lock: 423 lease held", ["lock", "--url", URL], { mock: lockAnswer({ status: 423, json: HELD }) });
add("lock: 423 without a label", ["lock", "--url", URL], { mock: lockAnswer({ status: 423, json: { ...HELD, label: undefined } }) });
add("lock: 423 with an empty label", ["lock", "--url", URL], { mock: lockAnswer({ status: 423, json: { ...HELD, label: "" } }) });
add("lock: 423 that is not JSON", ["lock", "--url", URL], { mock: lockAnswer({ status: 423, body: "locked" }) });
add("lock: 423 with odd values", ["lock", "--url", URL], { mock: lockAnswer({ status: 423, json: { holder: 7, label: [], expires_at: [1, null, "a", [2]] } }) });
add("lock: 423 with objects", ["lock", "--url", URL], { mock: lockAnswer({ status: 423, json: { holder: {}, label: { a: 1 }, expires_at: null } }) });
add("lock: 423 with zero and false", ["lock", "--url", URL], { mock: lockAnswer({ status: 423, json: { holder: false, label: 0, expires_at: true } }) });
add("lock: 423 with an array", ["lock", "--url", URL], { mock: lockAnswer({ status: 423, json: [HELD] }) });
add("lock: 423 is written as it is, the token too", ["lock", "--url", TOKEN_URL], { mock: lockAnswer({ status: 423, json: { ...HELD, holder: `lease:${FAKE}` } }), env: { WINRPC_TOKEN: FAKE } });
add("lock: 200 that is not JSON", ["lock", "--url", URL], { mock: lockAnswer({ status: 200, body: "hello" }) });
add("lock: 200 with an empty body", ["lock", "--url", URL], { mock: lockAnswer({ status: 200, body: "" }) });
add("lock: 200 with JSON and something after it", ["lock", "--url", URL], { mock: lockAnswer({ status: 200, body: "{} x" }) });
add("lock: 204", ["lock", "--url", URL], { mock: lockAnswer({ status: 204 }) });
add("lock: 201", ["lock", "--url", URL], { mock: lockAnswer({ status: 201, json: { created: true } }) });
add("lock: chunked", ["lock", "--url", URL], { mock: lockAnswer({ chunks: ['{"locked":', "false,", '"lease":null}'] }) });
add("lock: no length, the connection closed", ["lock", "--url", URL], { mock: lockAnswer({ close: true, body: JSON.stringify(LEASED) }) });
add("lock: HTTP/1.0", ["lock", "--url", URL], { mock: lockAnswer({ raw: `HTTP/1.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(BUSY)}` }) });
add("lock: JSON of every kind", ["lock", "--url", URL], {
  mock: lockAnswer({ status: 200, body: '{"s":"a\\"b\\\\c\\/d\\b\\f\\n\\r\\t\\u0001\\u001f\\u007f\\u2028\\u00e9é😀","n":[0,-0,1,-1,1.0,1e3,-2E2,9007199254740992,9007199254740993,1e400,-1e999],"b":[true,false,null],"e":[[],{}],"nested":{"a":[{"b":[[1]]}]}}' }),
});
add("lock: keys as JavaScript orders them", ["lock", "--url", URL], {
  mock: lockAnswer({ status: 200, body: '{"b":1,"a":2,"10":3,"2":4,"01":5,"-1":6,"4294967294":7,"4294967295":8,"b":9,"__proto__":10,"toString":11}' }),
});
add("lock: whitespace around JSON", ["lock", "--url", URL], { mock: lockAnswer({ status: 200, body: ' \t\r\n [ 1 , "x" ] \n' }) });
add("lock: a string as the answer", ["lock", "--url", URL], { mock: lockAnswer({ status: 200, body: '"just text"' }) });
add("lock: null as the answer", ["lock", "--url", URL], { mock: lockAnswer({ status: 200, body: "null" }) });
add("lock: not quite JSON", ["lock", "--url", URL], { mock: lockAnswer({ status: 200, body: '{"a":1,}' }) });
add("lock: a control character in a string is not JSON", ["lock", "--url", URL], { mock: lockAnswer({ status: 200, body: '{"a":"x\ty"}' }) });
add("lock: the token in the answer is masked", ["lock", "--url", URL], { mock: lockAnswer({ status: 200, json: { echo: `Bearer ${FAKE}`, url: `http://${FAKE}@winbox:12371/x` } }), env: { WINRPC_TOKEN: FAKE } });
notOk("lock: the token in an error is masked", ["lock", "--url", TOKEN_URL], lockAnswer({ status: 410, body: `no lease for ${FAKE}` }));
add("lock: a user part of another URL in the answer is masked", ["lock", "--url", URL], { mock: lockAnswer({ status: 200, json: { see: "ftp://anon@files.example/x" } }) });
add("lock: a token shorter than eight characters is not masked", ["lock", "--url", URL], { mock: lockAnswer({ status: 200, json: { echo: "fake123" } }), env: { WINRPC_TOKEN: "fake123" } });
add("lock: the longest secret is masked first", ["lock", "--url", "http://fake-user:fake-user-long@MOCKHOST"], { mock: lockAnswer({ status: 200, json: { a: "fake-user-long fake-user" } }), env: { WINRPC_URL: "http://fake-user:fake-user-long@127.0.0.1:9" } });

// What the binary does not read as bun does: it makes the request, then
// hands back, and the JavaScript asks again.
const twice = (name, args, mock, back, o = {}) => add(name, args, { mock, back, twice: true, ...o });
twice("lock: a redirect", ["lock", "--url", URL], { routes: { "GET /lock": { status: 302, headers: [["Location", "/moved/lock"]] }, "GET /moved/lock": { status: 200, json: UNLOCKED } } }, "fetch follows redirects; the binary does not");
twice("lock: a Content-Encoding", ["lock", "--url", URL], lockAnswer({ status: 200, json: UNLOCKED, headers: [["Content-Encoding", "identity"]] }), "fetch decompresses; the binary does not");
twice("lock: an empty reason phrase", ["lock", "--url", URL], lockAnswer({ raw: "HTTP/1.1 500 \r\nContent-Length: 1\r\n\r\nx" }), "how bun reads an odd status line is not imitated");
twice("lock: no reason phrase", ["lock", "--url", URL], lockAnswer({ raw: "HTTP/1.1 500\r\nContent-Length: 1\r\n\r\nx" }), "how bun reads an odd status line is not imitated");
twice("lock: a status of 600", ["lock", "--url", URL], lockAnswer({ raw: "HTTP/1.1 600 Odd\r\nContent-Length: 1\r\n\r\nx" }), "a status outside 200-599 is not imitated");
twice("lock: a fraction in the answer", ["lock", "--url", URL], ok({ ...BUSY, expiresIn: 59000.5 }), "JavaScript's number formatting is not ported beyond integers");
twice("lock: an integer beyond 2^53", ["lock", "--url", URL], lockAnswer({ status: 200, body: '{"n":18014398509481985}' }), "JavaScript's number formatting is not ported beyond integers");
twice("lock: a lone surrogate", ["lock", "--url", URL], lockAnswer({ status: 200, body: '{"s":"\\ud800"}' }), "a string with half a surrogate pair is not held");
twice("lock: a byte order mark", ["lock", "--url", URL], lockAnswer({ status: 200, body: "﻿{}" }), "whether fetch drops a byte order mark is not imitated");
twice("lock: 423 with a holder JavaScript cannot print", ["lock", "--url", URL], lockAnswer({ status: 423, json: { holder: { toString: "x" } } }), "String() throws, and yargs reports it");
twice("lock: the connection is closed without an answer", ["lock", "--url", URL], lockAnswer({ drop: true }), "a failed fetch is reported in bun's words", { tty: ADDRESS_SHOWN });
twice("lock: a body shorter than its length", ["lock", "--url", URL], lockAnswer({ raw: "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n{}" }), "a failed fetch is reported in bun's words");
twice("lock: a header line that is not one", ["lock", "--url", URL], lockAnswer({ raw: "HTTP/1.1 200 OK\r\nnot a header\r\nContent-Length: 2\r\n\r\n{}" }), "how bun reads an odd header is not imitated", { tty: ADDRESS_SHOWN });
twice("lock: a 1xx before the answer", ["lock", "--url", URL], lockAnswer({ raw: "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}" }), "an interim answer is not imitated");

// Where the binary goes back before it asks.
add("lock: http_proxy", ["lock", "--url", URL], { mock: ok(UNLOCKED), env: { http_proxy: "http://127.0.0.1:9" }, back: "fetch may go through a proxy", tty: ADDRESS_SHOWN });
add("lock: HTTPS_PROXY", ["lock", "--url", URL], { mock: ok(UNLOCKED), env: { HTTPS_PROXY: "http://127.0.0.1:9" }, back: "fetch may go through a proxy" });
add("lock: NO_PROXY", ["lock", "--url", URL], { mock: ok(UNLOCKED), env: { NO_PROXY: "*" }, back: "fetch may go through a proxy" });
add("lock: an https URL", ["lock", "--url", "https://127.0.0.1:9"], { back: "no TLS in the binary" });
add("lock: a token with a space at the end", ["lock", "--url", URL], { mock: ok(UNLOCKED), env: { WINRPC_TOKEN: "fake-token " }, back: "fetch trims a header value" });
add("lock: a lease with a tab", ["lock", "--url", URL], { mock: ok(UNLOCKED), env: { WINRPC_LEASE: "a\tb" }, back: "fetch checks a header value" });
add("lock: a 200 to a terminal", ["lock", "--url", URL], { mock: ok(LEASED), tty: "stdout", skip: NO_TTY_ON_WINDOWS });
add("lock: a 410 to a terminal", ["lock", "--url", URL], { mock: lockAnswer({ status: 410, json: GONE }), tty: "stderr", skip: NO_TTY_ON_WINDOWS, back: "bun colours console.error on a terminal", twice: true });
add("lock: a 423 to a terminal", ["lock", "--url", URL], { mock: lockAnswer({ status: 423, json: HELD }), tty: "stderr", skip: NO_TTY_ON_WINDOWS });
add("lock: FORCE_COLOR and a 200", ["lock", "--url", URL], { mock: ok(UNLOCKED), env: { FORCE_COLOR: "1" } });
add("lock: FORCE_COLOR and a 410", ["lock", "--url", URL], { mock: lockAnswer({ status: 410, json: GONE }), env: { FORCE_COLOR: "1" }, back: "bun colours console.error under FORCE_COLOR", twice: true });
notOk("lock: NO_COLOR and a 410", ["lock", "--url", URL], lockAnswer({ status: 410, json: GONE }), { env: { NO_COLOR: "1" } });

// ═══════════════════════════ what a client says before it sends anything ═══════════════════════════

add("lock: no URL", ["lock"]);
add("lock: an empty WINRPC_URL", ["lock"], { env: { WINRPC_URL: "" } });
add("lock: not a URL", ["lock", "--url=notaurl"]);
add("lock: not a URL, with spaces", ["lock", "--url", "my winrpc"]);
add("lock: WINRPC_URL host:port, which is a URL of the scheme host", ["lock"], { env: { WINRPC_URL: "winbox:12371" }, back: "URLs other than http are not imitated" });
add("lock: WINRPC_URL without a scheme", ["lock"], { env: { WINRPC_URL: "192.0.2.1/x" } });
add("lock: an unclosed [ in the host, the token masked", ["lock", "--url", `http://${FAKE}@[bad`]);
add("lock: http:// alone", ["lock", "--url", "http://"]);
add("lock: no host after the user", ["lock", "--url", `http://${FAKE}@`]);
add("lock: a port and no host", ["lock", "--url", "http://:12371"]);
add("lock: a port out of range", ["lock", "--url", "http://127.0.0.1:65536"]);
add("lock: a port that is not a number", ["lock", "--url", "http://127.0.0.1:12a"]);
add("lock: a token given as the URL is masked; an invalid WINRPC_URL adds no secret", ["lock", "--url", "fake-nope-token"], { env: { WINRPC_URL: "http://fake-user-of-a-bad-url@[", WINRPC_TOKEN: "fake-nope-token" } });
add("lock: an ftp URL", ["lock", "--url", "ftp://127.0.0.1:9"], { back: "URLs other than http are not imitated" });
add("lock: http: without slashes", ["lock", "--url", "http:127.0.0.1:9"], { back: "URLs other than http://host are not imitated" });
add("lock: a shortened IPv4 address", ["lock", "--url", "http://127.1:9"], { back: "IPv4 addresses of other spellings are not imitated" });
add("lock: an IPv6 address", ["lock", "--url", "http://[::1]:9"], { back: "IPv6 hosts are not imitated" });
add("lock: a percent escape in the token", ["lock", "--url", "http://fake%2Dtoken@127.0.0.1:9"], { back: "percent escapes are not imitated" });
add("lock: a dot segment in the path", ["lock", "--url", "http://127.0.0.1:9/a/../b"], { back: "dot segments are not imitated" });
add("lock: a query in the URL", ["lock", "--url", "http://127.0.0.1:9/?x=1"], { back: "a query is not imitated" });
add("lock acquire: no --owner", ["lock", "acquire", "--url", URL]);
add("lock acquire: no --owner, a label", ["lock", "acquire", "--label", "x", "--url", URL]);
add("lock acquire: no URL comes first", ["lock", "acquire"]);
add("lock acquire: an invalid URL comes first", ["lock", "acquire", "--url", "nope"]);
add("lock renew: no lease", ["lock", "renew", "--url", URL]);
add("lock release: no lease", ["lock", "release", "--ttl", "5", "--url", URL]);
add("lock renew: an empty WINRPC_LEASE", ["lock", "renew", "--url", URL], { env: { WINRPC_LEASE: "" } });
add("lock release: no lease, no URL", ["lock", "release"]);
add("ahk-repl: no URL", ["ahk-repl"], { stdin: "MsgBox 1\n" });
add("ahk-repl: no URL, a lease", ["ahk-repl", "--lease", "abc"], { stdin: "MsgBox 1\n" });
add("ahk-repl: not a URL", ["ahk-repl", "nope"], { stdin: "MsgBox 1\n" });
add("ahk-repl: an empty WINRPC_URL", ["ahk-repl"], { env: { WINRPC_URL: "" }, stdin: "MsgBox 1\n" });

// ═══════════════════════════ what changes something: the JavaScript sends it ═══════════════════════════

const ACQUIRED = { ok: true, lease: "0123456789abcdef0123456789abcdef", owner: "flow-a", label: "file picker", acquired_at: "2026-11-27T10:00:00.000Z", expires_at: "2026-11-27T10:02:00.000Z" };
const sends = "a request that changes something is sent by the JavaScript";
add("lock acquire: --owner", ["lock", "acquire", "--owner", "flow-a", "--url", TOKEN_URL], { mock: { routes: { "POST /lock/acquire": { status: 200, json: ACQUIRED } } }, back: sends });
add("lock acquire: every option", ["lock", "acquire", "--owner=flow-a", "--label", "file picker", "--ttl", "90", "--wait", "2.5", "--url", TOKEN_URL], { mock: { routes: { "POST /lock/acquire": { status: 200, json: ACQUIRED } } }, back: sends });
add("lock acquire: 423", ["lock", "acquire", "--owner", "flow-b", "--url", URL], { mock: { routes: { "POST /lock/acquire": { status: 423, json: HELD } } }, back: sends });
add("lock renew: a lease", ["lock", "renew", "0123456789abcdef0123456789abcdef", "--ttl", "60", "--url", URL], { mock: { routes: { "POST /lock/renew": { status: 200, json: { ...ACQUIRED, lease: undefined } } } }, back: sends });
add("lock renew: 410", ["lock", "renew", "--url", URL], { env: { WINRPC_LEASE: "fffffffffffffffffffffffffffffff0" }, mock: { routes: { "POST /lock/renew": { status: 410, json: GONE } } }, back: sends });
add("lock release: WINRPC_LEASE", ["lock", "release", "--url", URL], { env: { WINRPC_LEASE: "0123456789abcdef0123456789abcdef" }, mock: { routes: { "POST /lock/release": { status: 200, json: { ok: true } } } }, back: sends });
const EVAL_OK = { routes: { "POST /ahk-eval": { status: 200, json: { ok: true, stdout: "done", stderr: "", exitCode: 0 } } } };
add("ahk-repl: lines through a pipe", ["ahk-repl", URL], { mock: EVAL_OK, stdin: "MsgBox 1\n\n  WinGetTitle  \n", back: sends, after: ["sort <ROOT>/requests.log"] });
add("ahk-repl: the lease", ["ahk-repl", "--lease", "0123456789abcdef0123456789abcdef", TOKEN_URL], { mock: EVAL_OK, stdin: "MsgBox 1\n", back: sends });
add("ahk-repl: 423", ["ahk-repl", TOKEN_URL], { mock: { routes: { "POST /ahk-eval": { status: 423, json: HELD } } }, stdin: "MsgBox 1\n", back: sends });
add("ahk-repl: an empty stdin", ["ahk-repl", URL], { mock: EVAL_OK, stdin: "", back: "ahk-repl with a URL reads stdin" });

// ═══════════════════════════ the rest goes to yargs ═══════════════════════════

const yargs = "yargs's own reading of the command line";
for (const [what, args] of [
  ["serve with an unknown option", ["serve", "--bogus"]],
  ["tray with an unknown option", ["tray", "--bogus"]],
  ["an unknown option alone", ["--bogus"]],
  ["an unknown command", ["frobnicate"]],
  ["lock with an unknown action", ["lock", "frob"]],
  ["lock with an unknown option", ["lock", "--bogus", "1"]],
  ["lock --url without a value", ["lock", "--url"]],
  ["lock --url twice", ["lock", "--url", "http://127.0.0.1:9", "--url", "http://127.0.0.1:9"]],
  ["lock with three positionals", ["lock", "show", "a", "b"]],
  ["lock --ttl that is not a number", ["lock", "--ttl", "abc"]],
  ["lock -- show", ["lock", "--", "show"]],
  ["ahk-repl with two URLs", ["ahk-repl", "http://127.0.0.1:9", "http://127.0.0.1:9"]],
  ["ahk-repl --url", ["ahk-repl", "--url", "http://127.0.0.1:9"]],
]) {
  add(`yargs: ${what}`, args, { back: yargs, stdin: "" });
}

// ═══════════════════════════ the .env files bun loads ═══════════════════════════
//
// WINRPC_URL set to text without a scheme is printed back by every client
// command (`error: invalid URL: <the text>`), which shows the value bun read.

const bunEnv = (name, files, o = {}) => add(`bun env: ${name}`, ["lock"], { ...o, files: { ...files, ...(o.files || {}) } });
bunEnv("WINRPC_URL in .env", { ".env": "WINRPC_URL=from-env-file\n" });
bunEnv("in .env.local", { ".env.local": "WINRPC_URL=from-local\n" });
bunEnv("in .env.development", { ".env.development": "WINRPC_URL=from-development\n" });
bunEnv("in .env.development.local", { ".env.development.local": "WINRPC_URL=from-development-local\n" });
bunEnv(".env.production is not read", { ".env.production": "WINRPC_URL=from-production\n" });
bunEnv(".env.test is not read", { ".env.test": "WINRPC_URL=from-test\n" });
const FOUR = { ".env": "WINRPC_URL=from-env-file\n", ".env.development": "WINRPC_URL=from-development\n", ".env.local": "WINRPC_URL=from-local\n", ".env.development.local": "WINRPC_URL=from-development-local\n" };
bunEnv(".env.development.local wins", FOUR);
bunEnv(".env.local wins over .env.development and .env", { ".env": FOUR[".env"], ".env.development": FOUR[".env.development"], ".env.local": FOUR[".env.local"] });
bunEnv(".env.development wins over .env", { ".env": FOUR[".env"], ".env.development": FOUR[".env.development"] });
bunEnv("the real environment wins", FOUR, { env: { WINRPC_URL: "from-the-environment" } });
bunEnv("a variable set to nothing in the real environment stays so", FOUR, { env: { WINRPC_URL: "" } });
bunEnv("--url wins over the files", FOUR, {});
cases[cases.length - 1].args.push("--url", "from-the-flag");
bunEnv("files in the parent directory are not read", {}, { setup: ["echo WINRPC_URL=from-parent > ../.env.local"] });
bunEnv("the token and the URL from .env.local", { ".env.local": `WINRPC_URL=${URL}\nWINRPC_TOKEN=${FAKE}\n` }, { mock: ok(LEASED) });
bunEnv("the URL with its token from .env.local, as the banner says", { ".env.local": `WINRPC_URL=${TOKEN_URL}\n` }, { mock: ok(UNLOCKED) });
bunEnv("WINRPC_LEASE from .env", { ".env": "WINRPC_LEASE=0123456789abcdef0123456789abcdef\n", ".env.local": `WINRPC_URL=${TOKEN_URL}\n` }, { mock: ok(LEASED) });
bunEnv("WINRPC_TOKEN from .env masks the token in what is printed", { ".env": `WINRPC_TOKEN=${FAKE}\n` }, { mock: lockAnswer({ status: 410, body: `no lease for ${FAKE}` }), twice: true });
cases[cases.length - 1].args.push("--url", URL);
for (const [what, line, back] of [
  ["a bare value", "WINRPC_URL=dir/keys.txt"],
  ["spaces around a bare value", "WINRPC_URL= \t dir/k \t "],
  ["a bare value with a space inside", "WINRPC_URL=my url"],
  ["a comment after a bare value", "WINRPC_URL=dir/k # the url"],
  ["a # glued to a bare value", "WINRPC_URL=dir/k#not-part"],
  ["an empty value", "WINRPC_URL="],
  ["only a comment as value", "WINRPC_URL= # nothing"],
  ["double quotes", 'WINRPC_URL="my url/k #1"'],
  ["double quotes, padded inside", 'WINRPC_URL=" k "'],
  ["double quotes and a comment", 'WINRPC_URL="k" # c'],
  ["double quotes and a glued comment", 'WINRPC_URL="k"#c'],
  ["a single quote inside double quotes", 'WINRPC_URL="it\'s"'],
  ["a backtick inside double quotes", 'WINRPC_URL="a`b"'],
  ["single quotes", "WINRPC_URL='my url/k #1'"],
  ["double quotes inside single quotes", "WINRPC_URL='{\"a\":1}'"],
  ["a backtick inside single quotes", "WINRPC_URL='a`b'"],
  ["empty double quotes", 'WINRPC_URL=""'],
  ["empty single quotes", "WINRPC_URL=''"],
  ["an equals sign in the value", "WINRPC_URL=a=b"],
  ["a backslash in a bare value", "WINRPC_URL=a\\b"],
  ["letters beyond ASCII", "WINRPC_URL=clés→鍵"],
  ["a tab before the quote", 'WINRPC_URL=\t"k"'],
  ["the same name twice: the last wins", "WINRPC_URL=k1\nT_OTHER=1\nWINRPC_URL=k2"],
  ["a $ in a bare value", "WINRPC_URL=a$b", "bun expands $b"],
  ["a $ at the end", "WINRPC_URL=cost$", "a $ is where bun starts to expand"],
  ["${…} in double quotes", 'WINRPC_URL="${HOME}/k"', "bun expands ${HOME}"],
  ["a $ in single quotes", "WINRPC_URL='a$b'", "bun expands even in single quotes"],
  ["an escape in double quotes", 'WINRPC_URL="a\\nb"', "bun unescapes \\n"],
  ["a backslash in single quotes", "WINRPC_URL='a\\nb'", "backslashes in quotes are not imitated"],
  ["a value over two lines", 'WINRPC_URL="a\nb"', "values over several lines are not imitated"],
  ["no closing quote", 'WINRPC_URL="a', "an open quote is not imitated"],
  ["backticks", "WINRPC_URL=`k`", "backtick quoting is not imitated"],
  ["a quote inside a bare value", "WINRPC_URL=it's", "quotes inside a bare value are not imitated"],
  ["text after the closing quote", 'WINRPC_URL="a"b', "text after a closing quote is not imitated"],
  ["a quote in the comment", "WINRPC_URL=k # it's", "quotes in a comment are not imitated"],
  ["a tab inside a bare value", "WINRPC_URL=a\tb", "control characters in a value are not imitated"],
  ["export", "export WINRPC_URL=k", "export is not imitated"],
  ["an indented line", "  WINRPC_URL=k", "indentation is not imitated"],
  ["a space before the equals sign", "WINRPC_URL =k", "spaces before = are not imitated"],
  ["a line without an equals sign", "WINRPC_URL", "a line without = is not imitated"],
  ["a name with a dot", "A.B=1\nWINRPC_URL=k", "names with . or - are not imitated"],
  ["a byte order mark", "﻿WINRPC_URL=k", "a byte order mark is not imitated"],
  ["a lone carriage return", "A=1\rWINRPC_URL=k", "a lone carriage return is not imitated"],
  ["a variable for bun", "BUN_CONFIG_VERBOSE_FETCH=1\nWINRPC_URL=k", "variables that steer bun are not imitated"],
  ["a proxy in the file", "HTTP_PROXY=http://127.0.0.1:9\nWINRPC_URL=k", "variables that steer fetch are not imitated"],
  ["LANG in the file", "LANG=de_DE.UTF-8\nWINRPC_URL=k", "variables that steer yargs are not imitated"],
]) {
  bunEnv(what, { ".env.development": `# comment\n\n${line}\nT_AFTER=1\n` }, back ? { back } : {});
  if (!back) bunEnv(`${what}, CRLF`, { ".env.development": `# comment\r\n\r\n${line}\r\nT_AFTER=1\r\n` });
}
bunEnv("no newline at the end", { ".env.development": "WINRPC_URL=k" });
bunEnv("an empty file", { ".env.development": "" });
bunEnv("comments and blank lines only", { ".env.development": "# a\n\n   \n\t\n#b" });
bunEnv("a file that is not UTF-8", { ".env.development": "WINRPC_URL=k\n" }, { setup: ["printf 'A=\\377\\n' >> .env.development"], back: "a .env file that is not UTF-8 is not imitated" });
bunEnv("a .env that is a directory", {}, { setup: ["mkdir .env.development"], back: "a .env that is not a file is not imitated" });
bunEnv("a .env that is a symlink is read", { elsewhere: "WINRPC_URL=from-link\n" }, { setup: ["ln -s elsewhere .env.development"], skip: { win32: "Git Bash's ln copies the file instead of linking it" } });

// On Windows a variable's name is one in any letter case; elsewhere these are two.
add("lock: winrpc_url in lower case", ["lock"], { env: { winrpc_url: "lower-case-name" } });
add("bun env: winrpc_url in lower case in .env.local", ["lock"], { files: { ".env.local": "winrpc_url=lower-case-name\n" } });

const json = `${JSON.stringify({ env: { WINRPC_PARITY_LOG: "<ROOT>/requests.log" }, cases }, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const committed = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
  if (committed !== json) {
    console.error("rs/parity.json is not what rs/parity.gen.mjs writes: run node rs/parity.gen.mjs");
    process.exit(1);
  }
  console.error(`rs/parity.json: ${cases.length} cases, as rs/parity.gen.mjs writes them`);
} else {
  fs.writeFileSync(out, json);
  console.error(`rs/parity.json: ${cases.length} cases`);
}
