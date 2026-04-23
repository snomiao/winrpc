#!/usr/bin/env bun
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { createInterface } from "readline";
import { makeApp } from "./server";
import { printTokenBanner } from "./auth";

function serve(host: string, port: number) {
  makeApp().listen({ hostname: host, port }, () => {
    console.log(`winrpc listening on http://${host}:${port}`);
    console.log(`  AHK_TEMPLATES_DIR=${process.env.AHK_TEMPLATES_DIR ?? "<cwd>/ahk"}`);
    console.log(`  Platform: ${process.platform}  PID: ${process.pid}`);
    printTokenBanner(host, port);
  });
}

async function ahkRepl(target: string) {
  const u = new URL(target);
  const token = decodeURIComponent(u.username || "");
  u.username = "";
  u.password = "";
  const base = u.toString().replace(/\/$/, "");
  const endpoint = `${base}/ahk-eval`;
  const headers: Record<string, string> = { "content-type": "text/plain" };
  if (token) headers["authorization"] = `Bearer ${token}`;

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
    (y) => y.positional("url", {
      type: "string",
      describe: "Target winrpc URL (defaults to $WINRPC_URL)",
      default: process.env.WINRPC_URL,
    }),
    async (argv) => {
      if (!argv.url) {
        console.error("error: provide <url> or set WINRPC_URL");
        process.exit(2);
      }
      await ahkRepl(argv.url);
    },
  )
  .strict()
  .help()
  .parse();
