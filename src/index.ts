#!/usr/bin/env bun
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { createInterface } from "readline";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
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

// Read the response body once, parse as JSON, fall back to {stderr: text}.
async function readRpcBody(res: Response): Promise<any> {
  const txt = await res.text();
  try { return JSON.parse(txt); } catch { return { stderr: txt }; }
}

function printStreams(data: any) {
  if (data?.stdout) process.stdout.write(data.stdout.endsWith("\n") ? data.stdout : data.stdout + "\n");
  if (data?.stderr) process.stderr.write(data.stderr.endsWith("\n") ? data.stderr : data.stderr + "\n");
}

// One-shot POST of a text body to /shell or /ahk-eval: mirror the streams, exit with the remote exit code.
async function oneShot(c: Client, path: string, body: string): Promise<never> {
  let res: Response;
  try {
    res = await fetch(`${c.base}${path}`, { method: "POST", headers: { ...c.headers, "content-type": "text/plain" }, body });
  } catch (e: any) {
    console.error(`error: cannot reach winrpc at ${c.base} (${path}): ${e?.code ?? e?.message ?? e}`);
    process.exit(1);
  }
  const data = await readRpcBody(res);
  if (res.status === 423) {
    printLeaseHeld(data);
    process.exit(EXIT_LEASE_HELD);
  }
  printStreams(data);
  process.exit(typeof data.exitCode === "number" ? data.exitCode : data.ok === false || !res.ok ? 1 : 0);
}

// Interactive loop: POST each non-empty stdin line to `path`, unpack the streams inline.
async function repl(c: Client, path: string, label: string) {
  const endpoint = `${c.base}${path}`;
  const headers: Record<string, string> = { ...c.headers, "content-type": "text/plain" };

  const tty = process.stdin.isTTY;
  if (tty) console.error(`winrpc ${label}-repl → ${c.base}  (Ctrl-D to exit)`);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: tty,
    prompt: tty ? `${label}> ` : "",
  });
  if (tty) rl.prompt();

  rl.on("line", async (line) => {
    const script = line.trim();
    if (!script) { if (tty) rl.prompt(); return; }
    try {
      const res = await fetch(endpoint, { method: "POST", headers, body: script });
      const data = await readRpcBody(res);
      if (res.status === 423) {
        printLeaseHeld(data);
        process.exit(EXIT_LEASE_HELD);
      }
      printStreams(data);
      if (data.ok === false && !data.stderr) process.stderr.write(`[exit ${data.exitCode ?? "?"}]\n`);
    } catch (e: any) {
      process.stderr.write(`[request failed] ${e?.message ?? e}\n`);
    }
    if (tty) rl.prompt();
  });

  await new Promise<void>((resolve) => rl.on("close", resolve));
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const c of process.stdin) chunks.push(c as Uint8Array);
  return Buffer.concat(chunks).toString("utf8");
}

// One-shot body from positional words: none → undefined, "-" → stdin, else joined with spaces.
// yargs drops a lone "-", so it is also recovered from the raw argv.
async function resolveBody(parts: string[]): Promise<string | undefined> {
  if (parts.length === 1 && parts[0] === "-") return readStdin();
  if (parts.length === 0) return hideBin(process.argv).includes("-") ? readStdin() : undefined;
  return parts.join(" ");
}

async function screenshot(c: Client, out: string | undefined, query: Record<string, string | undefined>) {
  const qs = new URLSearchParams(Object.entries(query).filter((e): e is [string, string] => e[1] !== undefined));
  const path = `/screenshot${qs.size ? `?${qs}` : ""}`;
  let res: Response;
  try {
    res = await fetch(`${c.base}${path}`, { method: "POST", headers: c.headers });
  } catch (e: any) {
    console.error(`error: cannot reach winrpc at ${c.base} (/screenshot): ${e?.code ?? e?.message ?? e}`);
    process.exit(1);
  }
  if (res.status === 423) {
    printLeaseHeld(await readRpcBody(res));
    process.exit(EXIT_LEASE_HELD);
  }
  if (!res.ok) {
    console.error(`HTTP ${res.status} ${res.statusText} on /screenshot`);
    console.error(await res.text());
    process.exit(1);
  }
  const file = resolve(out ?? `./tmp/winrpc-shot-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
  await mkdir(dirname(file), { recursive: true });
  await Bun.write(file, await res.arrayBuffer());
  const remote = res.headers.get("x-screenshot-path");
  if (remote) process.stderr.write(`X-Screenshot-Path: ${remote}\n`);
  console.log(file);
}

// No `default:` on --url: yargs prints defaults in --help, and $WINRPC_URL carries the token.
const urlOption = (y: any) => y.option("url", { type: "string", describe: "Target winrpc URL (default $WINRPC_URL)" });
const leaseOption = (y: any) =>
  y.option("lease", { type: "string", describe: "UI lease id from `winrpc lock acquire` (default $WINRPC_LEASE)" });
const words = (argv: any, key: string) => [...(argv[key] ?? []), ...(argv["--"] ?? [])].map(String);

await yargs(hideBin(process.argv))
  .scriptName("winrpc")
  .parserConfiguration({ "populate--": true })
  .command(
    ["serve", "$0"],
    "Start the winrpc server",
    (y) => y
      .option("host", { type: "string", default: process.env.HOST ?? "0.0.0.0" })
      .option("port", { type: "number", default: parseInt(process.env.PORT ?? "12371") }),
    (argv) => serve(argv.host, argv.port),
  )
  .command(
    "health",
    "GET /health on the target server (JSON)",
    urlOption,
    (argv) => postJson(resolveClient(argv.url as string | undefined), "/health"),
  )
  .command(
    "version",
    "GET /version on the target server (JSON)",
    urlOption,
    (argv) => postJson(resolveClient(argv.url as string | undefined), "/version"),
  )
  .command(
    "shell [command..]",
    "Run PowerShell on the target server: one-shot with a command ('-' reads stdin), else a shell> REPL",
    (y) => leaseOption(urlOption(y)).positional("command", { type: "string", array: true }),
    async (argv) => {
      const c = resolveClient(argv.url as string | undefined, argv.lease as string | undefined);
      const body = await resolveBody(words(argv, "command"));
      if (body === undefined) await repl(c, "/shell", "shell");
      else await oneShot(c, "/shell", body);
    },
  )
  .command(
    "ahk [script..]",
    "Run an AHK v2 script once on the target server ('-' reads stdin); exits with its exit code",
    (y) => leaseOption(urlOption(y)).positional("script", { type: "string", array: true }),
    async (argv) => {
      const c = resolveClient(argv.url as string | undefined, argv.lease as string | undefined);
      const body = await resolveBody(words(argv, "script"));
      if (body === undefined) {
        console.error("error: ahk needs a script argument (or '-' for stdin); use ahk-repl for a loop");
        process.exit(2);
      }
      await oneShot(c, "/ahk-eval", body);
    },
  )
  .command(
    "ahk-repl [url]",
    "Pipe stdin lines to a target winrpc server as AHK commands, print responses inline",
    (y) => leaseOption(urlOption(y)).positional("url", {
      type: "string",
      describe: `Target winrpc URL (default $WINRPC_URL${process.env.WINRPC_URL ? ", set" : ", unset"})`,
    }),
    async (argv) => repl(resolveClient(argv.url as string | undefined, argv.lease as string | undefined), "/ahk-eval", "ahk"),
  )
  .command(
    "screenshot [path]",
    "Capture the screen (or one window) and save the PNG locally; prints the local path",
    (y) => leaseOption(urlOption(y))
      .positional("path", { type: "string", describe: "Output PNG (default ./tmp/winrpc-shot-<ts>.png)" })
      .option("window", { type: "string", describe: "Capture the window whose title contains this" })
      .option("process", { type: "string", describe: "Capture the window of this process name" })
      .option("foreground", { type: "boolean", describe: "Bring the target window forward (default true)" })
      .option("crop", { type: "string", describe: "x,y,w,h region" })
      .option("maxw", { type: "number", describe: "Downscale to at most this width" }),
    (argv) => screenshot(resolveClient(argv.url as string | undefined, argv.lease as string | undefined), argv.path as string | undefined, {
      window: argv.window as string | undefined,
      process: argv.process as string | undefined,
      foreground: argv.foreground === undefined ? undefined : argv.foreground ? "1" : "0",
      crop: argv.crop as string | undefined,
      maxw: argv.maxw === undefined ? undefined : String(argv.maxw),
    }),
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
  .command(
    "force-unlock",
    "POST /lock/force-unlock: drop the UI lock and any lease (JSON)",
    urlOption,
    (argv) => postJson(resolveClient(argv.url as string | undefined), "/lock/force-unlock", {}),
  )
  .command(
    "redeploy",
    "POST /redeploy: exit the server so its supervisor restarts it (JSON)",
    urlOption,
    (argv) => postJson(resolveClient(argv.url as string | undefined), "/redeploy", {}),
  )
  .command(
    "tray",
    "Show a system-tray icon tracking this host's winrpc server",
    (y) => y.option("port", { type: "number", default: parseInt(process.env.PORT ?? "12371") }),
    async (argv) => {
      // Imported lazily: the tray pulls in systray2 and spawns its helper
      // binary, which `winrpc serve` must never do.
      process.env.PORT = String(argv.port);
      const { startTray } = await import("./tray");
      await startTray();
    },
  )
  .strict()
  .help()
  .parse();
