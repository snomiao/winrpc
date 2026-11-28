#!/usr/bin/env node
// Runs one command against a stand-in for a winrpc server.
//
//   node rs/parity/with-mock.mjs <command> [args...]
//
// The client commands of winrpc (`lock`, `ahk-repl`) talk to the server at
// the URL they are given. This starts a stand-in on 127.0.0.1, on a port of
// its own, writes its address into the command line and the environment in
// place of the word MOCKHOST (and its port in place of MOCKPORT), also in
// the `.env` files of the current directory, runs the command, and
// afterwards writes down every request the stand-in received, so that a
// parity case compares what each implementation asked for and not only
// what it printed. No real winrpc server is ever contacted, and nothing on
// the desktop is touched: the stand-in only answers.
//
// What the command prints to a pipe has the stand-in's address put back as
// MOCKHOST (and its port as MOCKPORT), so that both sides of a case, which
// get different ports, print the same. A terminal is left to the command.
//
// What the stand-in answers comes from WINRPC_PARITY_MOCK, a JSON object:
//
//   { "routes": { "GET /lock": <reply>, "POST /lock/acquire": <reply>, ... },
//     "listen": "127.0.0.1" }          // or "::1"
//
// A reply is answered every time its route is asked for (the binary may
// hand a GET back to the JavaScript, which then asks again), and is one of
//   { "status": 200, "json": <value> }               the value as JSON
//   { "status": 410, "reason": "Gone", "body": "...", "headers": [["k", "v"]] }
//   { "chunks": ["{\"a\":", "1}"] }                  chunked
//   { "close": true, "body": "..." }                 no length, then closed
//   { "raw": "HTTP/1.1 200 OK\r\n..." }              these bytes as they are
//   { "drop": true }                                 closed without an answer
// A route that is not listed is answered 404 (text naming it).
//
// The requests go to WINRPC_PARITY_LOG (default $TMPDIR/requests.log), one
// line each: method and target, then the headers a winrpc server reads
// (host, authorization, x-winrpc-lease, content-type), then the body. A
// token is written as it is only when it is one of the cases' made-up ones
// (it says "fake"). Neither variable reaches the command.

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const [program, ...programArgs] = process.argv.slice(2);
if (!program) {
  console.error("usage: with-mock.mjs <command> [args...]");
  process.exit(2);
}

const scenario = JSON.parse(process.env.WINRPC_PARITY_MOCK || "{}");
const routes = scenario.routes || {};
const listen = scenario.listen || "127.0.0.1";
const logFile = process.env.WINRPC_PARITY_LOG || path.join(process.env.TMPDIR || os.tmpdir(), "requests.log");
const REASONS = { 200: "OK", 204: "No Content", 302: "Found", 400: "Bad Request", 401: "Unauthorized", 404: "Not Found", 410: "Gone", 423: "Locked", 500: "Internal Server Error", 503: "Service Unavailable" };

const lines = [];

function shownToken(value) {
  if (value === undefined) return "(none)";
  return /fake/.test(value) && value.length <= 80 ? value : `(not a parity token, ${value.length} characters)`;
}

function reply(socket, route) {
  const r = routes[route] ?? { status: 404, body: `parity mock: no route for ${route}` };
  if (r.drop) return socket.destroy();
  if (r.raw !== undefined) return socket.end(Buffer.from(r.raw, "utf8"));
  const status = r.status ?? 200;
  const reason = r.reason ?? REASONS[status] ?? "Status";
  const headers = [...(r.headers || [])];
  let body = r.body ?? "";
  if (r.json !== undefined) {
    body = JSON.stringify(r.json);
    if (!headers.some(([k]) => k.toLowerCase() === "content-type")) headers.push(["Content-Type", "application/json;charset=utf-8"]);
  }
  let payload;
  if (r.chunks) {
    headers.push(["Transfer-Encoding", "chunked"]);
    payload = Buffer.concat(r.chunks.map((c) => { const b = Buffer.from(c, "utf8"); return Buffer.concat([Buffer.from(`${b.length.toString(16)}\r\n`), b, Buffer.from("\r\n")]); }).concat([Buffer.from("0\r\n\r\n")]));
  } else {
    payload = Buffer.from(body, "utf8");
    if (!r.close) headers.push(["Content-Length", String(payload.length)]);
  }
  if (r.close) headers.push(["Connection", "close"]);
  const head = `HTTP/1.1 ${status} ${reason}\r\n${headers.map(([k, v]) => `${k}: ${v}\r\n`).join("")}\r\n`;
  socket.end(Buffer.concat([Buffer.from(head, "utf8"), payload]));
}

const server = net.createServer((socket) => {
  socket.on("error", () => {});
  let buffer = Buffer.alloc(0);
  let done = false;
  socket.on("data", (data) => {
    if (done) return;
    buffer = Buffer.concat([buffer, data]);
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const head = buffer.subarray(0, end).toString("latin1").split("\r\n");
    const [method, target] = head[0].split(" ");
    const headers = {};
    for (const line of head.slice(1)) {
      const colon = line.indexOf(":");
      if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    const length = Number(headers["content-length"] || 0);
    if (buffer.length < end + 4 + length) return;
    done = true;
    const body = buffer.subarray(end + 4, end + 4 + length).toString("utf8");
    lines.push([
      `${method} ${target}`,
      `host: ${headers.host ?? "(none)"}`,
      `authorization: ${shownToken(headers.authorization)}`,
      `x-winrpc-lease: ${headers["x-winrpc-lease"] ?? "(none)"}`,
      `content-type: ${headers["content-type"] ?? "(none)"}`,
      body,
    ].join("\t"));
    reply(socket, `${method} ${target}`);
  });
});

server.listen(0, listen, () => {
  const { port } = server.address();
  const address = listen === "::1" ? `[::1]:${port}` : `127.0.0.1:${port}`;
  const fill = (text) => text.replaceAll("MOCKHOST", address).replaceAll("MOCKPORT", String(port));
  const unfill = (buffer) => {
    let text = buffer.toString("latin1");
    text = text.replaceAll(address, "MOCKHOST").replaceAll(`:${port}`, ":MOCKPORT");
    return Buffer.from(text, "latin1");
  };
  for (const name of [".env", ".env.local", ".env.development", ".env.development.local"]) {
    try {
      const text = fs.readFileSync(name, "latin1");
      if (/MOCKHOST|MOCKPORT/.test(text)) fs.writeFileSync(name, fill(text), "latin1");
    } catch {}
  }
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^WINRPC_PARITY_/i.test(key)) continue;
    env[key] = fill(value);
  }
  const piped = [process.stdout, process.stderr].map((stream) => !stream.isTTY);
  const child = spawn(program, programArgs.map(fill), {
    stdio: ["inherit", piped[0] ? "pipe" : "inherit", piped[1] ? "pipe" : "inherit"],
    env,
  });
  const out = [[], []];
  if (piped[0]) child.stdout.on("data", (d) => out[0].push(d));
  if (piped[1]) child.stderr.on("data", (d) => out[1].push(d));
  let finished = false;
  const finish = (code) => {
    if (finished) return;
    finished = true;
    fs.writeFileSync(logFile, lines.length ? `${lines.map((l) => unfill(Buffer.from(l, "utf8")).toString("utf8")).join("\n")}\n` : "(no requests)\n");
    const flush = (stream, chunks, then) => (chunks.length ? stream.write(unfill(Buffer.concat(chunks)), then) : then());
    flush(process.stdout, out[0], () => flush(process.stderr, out[1], () => process.exit(code)));
  };
  child.on("error", (error) => {
    console.error(`with-mock: could not run ${program}: ${error.message}`);
    finish(127);
  });
  child.on("close", (code, signal) => finish(code ?? 128 + (os.constants.signals[signal] ?? 0)));
});
