#!/usr/bin/env bun
// Records from bun what the Rust port has to agree with, for `cargo test`
// (rs/src/vectors.rs) to compare mechanically:
//
// - `new URL(text)` for some 2,000 texts: whether it throws, and if not
//   `toString()` once username and password are cleared, and the two
//   (`[text, href, username, password]`, or `[text, null]` when it throws);
// - `redactUrl(text)` of src/redact.ts for those and for text around them;
// - `knownSecrets(env)` of src/redact.ts for pairs of WINRPC_TOKEN and
//   WINRPC_URL.
//
//   bun rs/vectors.gen.mjs [--check]
//
// writes rs/src/testdata/vectors.json, or with --check fails when this bun
// records something else than the committed file holds. rs/parity/proof.sh
// runs the check on every system, with the bun of the parity run.

import fs from "node:fs";
import path from "node:path";
import { knownSecrets, redactUrl } from "../src/redact.ts";

const out = path.join(import.meta.dir, "src", "testdata", "vectors.json");

const texts = new Set();
const add = (text) => texts.add(text);

const schemes = ["http", "HTTP", "Http", "https", "ftp", "ws", "file", "h", "a+b.c-d", "1a", ""];
const separators = ["://", ":/", ":", ":///", "//", ":\\\\"];
for (const scheme of schemes) for (const separator of separators) for (const host of ["127.0.0.1:9", "h", ""]) add(`${scheme}${separator}${host}`);

const users = ["", "u@", "u:p@", ":p@", "@", "fake-token-0123456789@", "u.n_m~-1:p.w_d~-2@", "u%41@", "a@b@", "u:p:q@", "[@", "\u00fc@", "u p@", "u!$&'()*+,;=@"];
const hosts = [
  "127.0.0.1", "0.0.0.0", "10.0.0.255", "255.255.255.255", "localhost", "LOCALHOST", "h", "my-host.example", "WinBox.Local", "a1.b2.c3",
  "1.2.3", "127.1", "256.1.1.1", "0x7f.0.0.1", "1.2.3.04", "01.2.3.4", "a.1", "1.a", "[::1]", "[bad", "", "a..b", "a.", "-a", "a-", "xn--a",
  "ab--c", "a_b", "%41", "a b", "\u00e9", "a".repeat(64), "1.2.3.4.5", "999999999999",
];
const ports = ["", ":", ":80", ":443", ":0", ":12371", ":0009", ":65535", ":65536", ":99999", ":000000000080", ":12a", ":-1", ": 1"];
for (const user of users) for (const host of hosts) for (const port of ports.slice(0, users.indexOf(user) < 4 ? ports.length : 4)) add(`http://${user}${host}${port}`);
const paths = ["", "/", "/x", "/x/", "//", "/a//b", "/a/../b", "/./", "/.", "/..", "/a/.", "/%41", "/a b", "/\u00e9", "?q", "/?q", "#f", "/#f", "\\x", "/a\\b", "/a:b@c", "/a'b(c)*+,;=!$&~", "/a\"b", "/a<b>", "/a`b", "/a{b}", "/a^b", "/a|b", "/a[b]"];
for (const host of ["127.0.0.1:12371", "u@h", "localhost", "h:80"]) for (const p of paths) add(`http://${host}${p}`);
for (const text of [
  "notaurl", "my winrpc", " \t", "dir/keys.txt", "cl\u00e9s\u2192\u9375", "a\tb c", "a\tb:c", " http://h ", "\thttp://h\n", "ht\ttp://h", "http://h\t/x",
  "winbox:12371", "192.0.2.1/x", "C:\\x", "c:/x", "//h/x", "/x", "?x", "x:", ":", "a:", "-a:b", ".a:b", "a\u0000:b", "\u0001http://h",
  "http://fake-token-0123456789abcdef@[bad", "http://fake@", "http://:12371", "http://u@:80", "http://127.0.0.1:65536", "http://127.0.0.1:12a",
  "http:127.0.0.1:9", "http:/127.0.0.1:9", "http:\\\\127.0.0.1:9", "https://127.0.0.1:9", "HTTPS://H:443/", "http://H:80/",
]) add(text);

const urls = [];
for (const text of texts) {
  let row;
  try {
    const u = new URL(text);
    const username = u.username;
    const password = u.password;
    u.username = "";
    u.password = "";
    row = [text, u.toString(), username, password];
  } catch {
    row = [text, null];
  }
  urls.push(row);
}

// Each text, and every seventh between other words.
const redactions = [];
const around = ["see ", "(", "\u00a0", "x", "\u3000"];
[...texts].forEach((text, i) => {
  redactions.push(text);
  if (i % 7 === 0) redactions.push(`${around[(i / 7) % around.length]}${text} now`);
});
for (const text of [
  "go to http://fake-token@192.0.2.1:12371/lock now", "a://b://c@d", "\u00e9://u@h 1a://u@h a://u\u00a0v@h a://\u00fc@h", "x://@h y:// a@b z://a/b@c w://a@b@c",
  "Unauthorized \u2014 include access token in URL: http://<token>@host:port", "http://a@b http://c@d", "http://a\u3000b@c", "http://a\ufeffb@c",
  "HTTP://U@H", "ab+c-d.e://u@h", "+a://u@h", "a1://u@h", "a://u\n@h", "a://u\t@h", "a://\ud83d\ude00@h", "ftp://anon@files.example/x",
]) redactions.push(text);
// [text, what redactUrl makes of it], or [text] when that is the text itself.
const redact = redactions.map((text) => (redactUrl(text) === text ? [text] : [text, redactUrl(text)]));

const tokens = [undefined, "", "fake-token-0123456789", "  fake-token-padded \t", "short", "seven77", "eight888", "fake token with spaces", "\u00e9t\u00e9-fake-token"];
const winrpcUrls = [undefined, "", "http://fake-user-0123@h", "http://fake-user:fake-pass-word@h", "http://:fake-only-password@h", "http://u@h", "http://fake-token-0123456789@h", "notaurl", "http://x@[bad", "winbox:12371", "http://fake%2Duser-0123@h", "http://fake-a@b@h"];
const secrets = [];
for (const token of tokens) for (const url of winrpcUrls) {
  const env = {};
  if (token !== undefined) env.WINRPC_TOKEN = token;
  if (url !== undefined) env.WINRPC_URL = url;
  secrets.push([token ?? null, url ?? null, knownSecrets(env).sort((a, b) => b.length - a.length)]);
}

const json = `${JSON.stringify({ bun: "recorded with bun; see rs/vectors.gen.mjs", urls, redact, secrets })}\n`;
if (process.argv.includes("--check")) {
  const committed = fs.existsSync(out) ? fs.readFileSync(out, "utf8") : "";
  if (committed !== json) {
    const was = committed ? JSON.parse(committed) : { urls: [], redact: [], secrets: [] };
    const now = JSON.parse(json);
    for (const key of ["urls", "redact", "secrets"]) {
      const differ = now[key].filter((row, i) => JSON.stringify(row) !== JSON.stringify(was[key][i]));
      for (const row of differ.slice(0, 5)) console.error(`  ${key}: bun ${Bun.version} gives ${JSON.stringify(row)}`);
    }
    console.error(`rs/src/testdata/vectors.json is not what bun ${Bun.version} records: run bun rs/vectors.gen.mjs and look at the difference`);
    process.exit(1);
  }
  console.error(`rs/src/testdata/vectors.json: ${urls.length} URLs, ${redact.length} redactions, ${secrets.length} environments, as bun ${Bun.version} records them`);
} else {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, json);
  console.error(`rs/src/testdata/vectors.json: ${urls.length} URLs, ${redact.length} redactions, ${secrets.length} environments`);
}
