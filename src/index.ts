#!/usr/bin/env bun
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { createInterface } from "readline";
import { installConsoleRedaction, redactUrl } from "./redact";

// The token never reaches the terminal: every console.* call is redacted (help, errors, debug).
installConsoleRedaction();

// ./server and ./auth are imported in serve() only: importing auth creates a token in ./.env.local when
// none is set, which a client command (even --help) must never do.
async function serve(host: string, port: number) {
  const { makeApp } = await import("./server");
  const { printTokenBanner } = await import("./auth");
  makeApp().listen({ hostname: host, port }, () => {
    console.log(`winrpc listening on http://${host}:${port}`);
    console.log(`  AHK_TEMPLATES_DIR=${process.env.AHK_TEMPLATES_DIR ?? "<cwd>/ahk"}`);
    console.log(`  Platform: ${process.platform}  PID: ${process.pid}`);
    printTokenBanner(host, port);
  });
}

// ── client ───────────────────────────────────────────────────────────────────
// base URL = --url / positional (default $WINRPC_URL), user part stripped; token = URL username, else
// $WINRPC_TOKEN; lease = --lease, else $WINRPC_LEASE.
interface Client {
  base: string;
  headers: Record<string, string>;
}

function resolveClient(target: string | undefined, lease?: string): Client {
  const raw = target ?? process.env.WINRPC_URL;
  if (!raw) {
    console.error("error: provide <url> / --url or set WINRPC_URL");
    process.exit(2);
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    console.error(`error: invalid URL: ${redactUrl(raw)}`);
    process.exit(2);
  }
  const token = decodeURIComponent(u.username || "") || process.env.WINRPC_TOKEN || "";
  u.username = "";
  u.password = "";
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  const l = lease ?? process.env.WINRPC_LEASE;
  if (l) headers["x-winrpc-lease"] = l;
  return { base: u.toString().replace(/\/$/, ""), headers };
}

// 423: another owner holds a UI lease. EX_TEMPFAIL, so a caller can wait until expires_at and retry.
const EXIT_LEASE_HELD = 75;
function printLeaseHeld(data: any) {
  process.stderr.write(
    `ui lease held by ${data?.holder ?? "?"}${data?.label ? ` (${data.label})` : ""} until ${data?.expires_at ?? "?"}; retry after it, or pass --lease\n`,
  );
}

async function postJson(c: Client, path: string, body?: unknown) {
  let res: Response;
  try {
    res = await fetch(`${c.base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? c.headers : { ...c.headers, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e: any) {
    console.error(`error: cannot reach winrpc at ${c.base} (${path}): ${e?.code ?? e?.message ?? e}`);
    process.exit(1);
  }
  const txt = await res.text();
  let data: any = {};
  try { data = JSON.parse(txt); } catch {}
  if (res.status === 423) {
    printLeaseHeld(data);
    process.exit(EXIT_LEASE_HELD);
  }
  if (!res.ok) {
    console.error(`HTTP ${res.status} ${res.statusText} on ${path}`);
    console.error(txt);
    process.exit(1);
  }
  console.log(JSON.stringify(data, null, 2));
}

async function ahkRepl(c: Client) {
  const base = c.base;
  const endpoint = `${base}/ahk-eval`;
  const headers: Record<string, string> = { ...c.headers, "content-type": "text/plain" };

  const tty = process.stdin.isTTY;
  if (tty) console.error(`winrpc ahk-repl → ${base}  (Ctrl-D to exit)`);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: tty,
    prompt: tty ? "ahk> " : "",
  });
  if (tty) rl.prompt();

  rl.on("line", async (line) => {
    const script = line.trim();
    if (!script) { if (tty) rl.prompt(); return; }
    try {
      const res = await fetch(endpoint, { method: "POST", headers, body: script });
      const data: any = await res.json().catch(async () => ({ stderr: await res.text() }));
      if (res.status === 423) {
        printLeaseHeld(data);
        process.exit(EXIT_LEASE_HELD);
      }
      if (data.stdout) process.stdout.write(data.stdout.endsWith("\n") ? data.stdout : data.stdout + "\n");
      if (data.stderr) process.stderr.write(data.stderr.endsWith("\n") ? data.stderr : data.stderr + "\n");
      if (data.ok === false && !data.stderr) process.stderr.write(`[exit ${data.exitCode ?? "?"}]\n`);
    } catch (e: any) {
      process.stderr.write(`[request failed] ${e?.message ?? e}\n`);
    }
    if (tty) rl.prompt();
  });

  await new Promise<void>((resolve) => rl.on("close", resolve));
}

await yargs(hideBin(process.argv))
  .scriptName("winrpc")
  .command(
    ["serve", "$0"],
    "Start the winrpc server",
    (y) => y
      .option("host", { type: "string", default: process.env.HOST ?? "0.0.0.0" })
      .option("port", { type: "number", default: parseInt(process.env.PORT ?? "12371") }),
    (argv) => serve(argv.host, argv.port),
  )
  .command(
    "ahk-repl [url]",
    "Pipe stdin lines to a target winrpc server as AHK commands, print responses inline",
    // No `default:` here: yargs prints defaults in --help, and $WINRPC_URL carries the token.
    (y) => y
      .positional("url", {
        type: "string",
        describe: `Target winrpc URL (default $WINRPC_URL${process.env.WINRPC_URL ? ", set" : ", unset"})`,
      })
      .option("lease", { type: "string", describe: "UI lease id from `winrpc lock acquire` (default $WINRPC_LEASE)" }),
    async (argv) => ahkRepl(resolveClient(argv.url as string | undefined, argv.lease as string | undefined)),
  )
  .command(
    "lock [action] [lease]",
    "UI lock / lease: show (default), or acquire | renew | release a lease that holds the UI across steps (JSON)",
    (y) => y
      .positional("action", { type: "string", choices: ["show", "acquire", "renew", "release"], default: "show" })
      .positional("lease", { type: "string", describe: "lease id for renew/release (default $WINRPC_LEASE)" })
      .option("url", { type: "string", describe: "Target winrpc URL (default $WINRPC_URL)" })
      .option("owner", { type: "string", describe: "acquire: who holds it (tool / flow name)" })
      .option("label", { type: "string", describe: "acquire: what the flow does" })
      .option("ttl", { type: "number", describe: "acquire/renew: seconds (capped at 600)" })
      .option("wait", { type: "number", describe: "acquire: seconds to wait for a running request (max 60, default 30)" }),
    async (argv) => {
      const c = resolveClient(argv.url as string | undefined);
      const action = argv.action as string;
      if (action === "show") return postJson(c, "/lock");
      const ttl_ms = argv.ttl === undefined ? undefined : Number(argv.ttl) * 1000;
      if (action === "acquire") {
        if (!argv.owner) {
          console.error("error: lock acquire needs --owner");
          process.exit(2);
        }
        return postJson(c, "/lock/acquire", {
          owner: argv.owner,
          label: argv.label,
          ttl_ms,
          wait_ms: argv.wait === undefined ? undefined : Number(argv.wait) * 1000,
        });
      }
      const lease = (argv.lease as string | undefined) ?? process.env.WINRPC_LEASE;
      if (!lease) {
        console.error(`error: lock ${action} needs the lease id (argument or $WINRPC_LEASE)`);
        process.exit(2);
      }
      return postJson(c, `/lock/${action}`, action === "renew" ? { lease, ttl_ms } : { lease });
    },
  )
  .strict()
  .help()
  .parse();
