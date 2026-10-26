/**
 * win-automation-server — generic Windows UI automation HTTP server.
 *
 * Endpoints:
 *   GET  /health              — uptime check
 *   GET  /version             — git commit + platform
 *   GET  /lock                — current UI lock state (+ the active lease: owner, expires_at; never its id)
 *   POST /lock/acquire        — take a UI lease {owner, ttl_ms?, label?, wait_ms?} → {lease, expires_at} | 423
 *   POST /lock/renew          — extend it {lease, ttl_ms?} (capped) → {expires_at} | 410
 *   POST /lock/release        — end it {lease} → {ok} | 410
 *   POST /lock/force-unlock   — admin: force-release the UI lock (and any lease)
 *   POST /ahk-eval            — execute AHK v2 script (body = script text)
 *   POST /run-template        — execute named AHK template (body = {name, vars?, gui?, timeout?})
 *   POST /shell               — execute PowerShell inline (body = command text)
 *   POST /screenshot          — take screenshot, return PNG bytes
 *   POST /redeploy            — exit(2) so supervisor restarts with latest code
 *
 * UI mutex: all /ahk-eval and /run-template requests are serialized via an
 * in-process async queue (+ cross-process file lock at C:\tmp\im-ui.lock).
 * Multiple clients (wx-cli, qq-cli, …) all share the same lock file.
 * A lease (lease.ts) holds that lock across requests: the holder sends `X-Winrpc-Lease: <id>`;
 * guarded endpoints (WINRPC_LEASE_GUARDS) answer 423 {holder, expires_at} to everyone else.
 */

import { AsyncLocalStorage } from "async_hooks";
import { Elysia, t } from "elysia";
import { runAhk, ahkTemplate } from "./ahk";
import { runPowerShellInline } from "./powershell";
import { takeScreenshot } from "./screenshot";
import { runOcr, getOcrWorker, diffBoxes, type OcrBox } from "./ocr";
import { readLockState, forceUnlockUi, acquireUiLock, keepAlive } from "./ui-lock";
import { acquireLease, activeLease, dropLease, gate, isHolder, leaseGuards, releaseLease, renewLease } from "./lease";
import { checkAuth } from "./auth";
import { redactSecrets } from "./redact";

// ── In-process UI serialization queue ────────────────────────────────────────
// Serializes concurrent requests within this server process. The cross-process
// file lock (ui-lock.ts) handles coordination between separate processes.
const _lockCtx = new AsyncLocalStorage<string>();
let _queue: Promise<unknown> = Promise.resolve();

function withUiQueue<T>(label: string, fn: () => Promise<T>): Promise<T> {
  return enqueue(label, async () => {
    const fileLock = await acquireUiLock(label, { timeoutMs: 60_000 });
    const stop = keepAlive(fileLock); // a long action (run-template timeout) keeps its lock to the end
    try { return await _lockCtx.run(label, fn); }
    finally { stop(); fileLock.release(); }
  });
}

/** Tests only: put a job in the server's queue. */
export const _enqueue = <T>(job: () => Promise<T>) => enqueue("test", job);

/** Run `job` in this server's queue (one at a time). Reentrant calls run at once. */
function enqueue<T>(label: string, job: () => Promise<T>): Promise<T> {
  if (_lockCtx.getStore()) return job();
  const next = _queue.then(job);
  _queue = next.catch(() => undefined);
  return next;
}

/**
 * Lease gate for a guarded endpoint. The decision is made when the request reaches the front of the
 * queue, before any lock is taken (a lease may have been taken, renewed, released or expired meanwhile):
 * - holder: runs inside the lease (no second lock: the lease holds it); the lease can't be dropped while
 *   the action runs;
 * - blocked: 423 {holder, expires_at} at once (also checked before queueing, so it doesn't wait);
 * - free: the per-request lock as before (`fileLock: false` = only this server's queue, used by /shell,
 *   which never took the UI lock but must not run inside someone else's lease).
 */
async function guarded<T>(
  guard: string,
  request: Request,
  label: string,
  fn: () => Promise<T>,
  opts: { fileLock?: boolean } = {},
): Promise<T | Response> {
  const fileLock = opts.fileLock ?? true;
  const lease = request.headers.get("x-winrpc-lease");
  if (!leaseGuards().has(guard) && !isHolder(lease)) {
    // Not guarded (WINRPC_LEASE_GUARDS): a lease never refuses or delays it. With a lease active it runs
    // at once, without the UI lock (the lease holds that lock; waiting on it would delay up to 60 s).
    // Otherwise it takes the per-request lock as before, unless a lease starts while it is queued.
    if (!fileLock || activeLease()) return fn();
    return enqueue(label, async () => {
      if (activeLease()) return _lockCtx.run(label, fn);
      const fl = await acquireUiLock(label, { timeoutMs: 60_000 });
      const stop = keepAlive(fl);
      try { return await _lockCtx.run(label, fn); }
      finally { stop(); fl.release(); }
    });
  }
  // (the holder always runs inside its lease, guarded or not: below)
  const held = activeLease();
  if (held && !isHolder(lease)) return leaseHeld(held);
  return enqueue(label, async () => {
    const g = gate(lease);
    if (g.kind === "blocked") return leaseHeld(g.info);
    if (g.kind === "holder") {
      try { return await _lockCtx.run(label, fn); }
      finally { g.done(); }
    }
    if (!fileLock) return _lockCtx.run(label, fn);
    const fl = await acquireUiLock(label, { timeoutMs: 60_000 });
    const stop = keepAlive(fl);
    try { return await _lockCtx.run(label, fn); }
    finally { stop(); fl.release(); }
  });
}

function leaseHeld(info: { owner: string; label?: string; expires_at: string }): Response {
  return Response.json(
    { ok: false, error: "ui lease held", holder: info.owner, label: info.label, expires_at: info.expires_at },
    { status: 423 },
  );
}

// ── App ───────────────────────────────────────────────────────────────────────
export function makeApp() {
  return new Elysia()
    .onError(({ error }) => {
      // Let Response errors (e.g. 401 from auth) pass through unchanged.
      if (error instanceof Response) return error;
      // Return all other unhandled errors as JSON so clients can parse consistently.
      const msg = redactSecrets(error instanceof Error ? error.message : String(error));
      return Response.json({ ok: false, stdout: "", stderr: msg, exitCode: 1 }, { status: 500 });
    })
    .onRequest(({ request }) => {
      // /health is unauthenticated (for uptime checks without token)
      if (new URL(request.url).pathname === "/health") return;
      const err = checkAuth(request.headers.get("authorization"));
      if (err) throw err;
    })
    .get("/health", () => ({ ok: true, uptime: process.uptime(), pid: process.pid }))
    .get("/version", async () => {
      const rev = await Bun.spawn(["git", "rev-parse", "--short", "HEAD"], { stdout: "pipe" });
      const commit = (await new Response(rev.stdout).text()).trim();
      return { commit, platform: process.platform, node: process.version };
    })
    .get("/lock", () => {
      const state = readLockState();
      return state
        ? { locked: true, holder: state.holder, pid: state.pid, host: state.host, expiresIn: Math.max(0, state.expiresAt - Date.now()), lease: activeLease() }
        : { locked: false, lease: activeLease() };
    })
    .post("/lock/acquire", async ({ body }) => {
      // Through the queue: an in-flight request finishes first; requests queued behind see the lease.
      // In the queue (after any running request), without a lock of its own: the lease takes the lock.
      // wait_ms counts from arrival: time in the queue plus time waiting for the file lock. If the
      // deadline passes before the job starts, the job is cancelled (it never creates a lease) and the
      // caller gets 423 naming what holds the UI now.
      const waitMs = Math.max(0, Math.min(body.wait_ms ?? 30_000, 60_000));
      const deadline = Date.now() + waitMs;
      let started = false;
      let cancelled = false;
      const job = enqueue(`lease-acquire:${body.owner}`, async () => {
        if (cancelled) return null;
        started = true;
        return acquireLease({
          owner: body.owner,
          label: body.label,
          ttlMs: body.ttl_ms,
          waitMs: Math.max(0, deadline - Date.now()),
        });
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<"timeout">((res) => {
        timer = setTimeout(() => res("timeout"), waitMs);
      });
      let r = await Promise.race([job, timedOut]);
      if (r === "timeout" && started) r = await job; // already acquiring: its own wait is bounded by the deadline
      clearTimeout(timer);
      if (r === "timeout" || r === null) {
        cancelled = true;
        const st = readLockState();
        return leaseHeld(
          activeLease() ?? {
            owner: st?.holder ?? `(busy: ${_lockCtx.getStore() ?? "a running request"})`,
            label: st?.label,
            expires_at: st ? new Date(st.expiresAt).toISOString() : "",
          },
        );
      }
      if ("held" in r) return leaseHeld(r.info);
      return { ok: true, ...r };
    }, { body: t.Object({
      owner: t.String({ minLength: 1, maxLength: 100 }),
      label: t.Optional(t.String({ maxLength: 200 })),
      ttl_ms: t.Optional(t.Number()),
      wait_ms: t.Optional(t.Number()),
    }) })
    .post("/lock/renew", ({ body }) => {
      const r = renewLease(body.lease, body.ttl_ms);
      return r ? { ok: true, ...r } : Response.json({ ok: false, error: "no such lease (expired or released)" }, { status: 410 });
    }, { body: t.Object({ lease: t.String(), ttl_ms: t.Optional(t.Number()) }) })
    .post("/lock/release", ({ body }) => {
      return releaseLease(body.lease)
        ? { ok: true }
        : Response.json({ ok: false, error: "no such lease (expired or released)" }, { status: 410 });
    }, { body: t.Object({ lease: t.String() }) })
    .post("/lock/force-unlock", () => {
      const lease = dropLease();
      const prev = forceUnlockUi();
      return { ok: true, released: prev ?? null, lease };
    })
    .post("/ahk-eval", async ({ query: { gui, readonly }, request }) => {
      const script = await request.text();
      if (!script) return { ok: false, stdout: "", stderr: "Empty script", exitCode: 1 };
      const run = () => runAhk(script, { gui: gui === "1" || gui === "true" });
      // read-only probes (uia-pwd, uia-chats-sidebar) bypass the UI lock
      try {
        return await (readonly === "1" ? run() : guarded("ahk-eval", request, "ahk-eval", run));
      } catch (e: any) {
        return { ok: false, stdout: "", stderr: redactSecrets(e?.message ?? String(e)), exitCode: 1 };
      }
    }, { query: t.Object({ gui: t.Optional(t.String()), readonly: t.Optional(t.String()) }) })
    .post("/run-template", async ({ body, request }) => {
      try {
        const script = ahkTemplate(body.name, body.vars ?? {});
        return await guarded(
          "run-template",
          request,
          `run-template:${body.name}`,
          () => runAhk(script, { gui: !!body.gui, timeout: body.timeout }),
        );
      } catch (e: any) {
        return { ok: false, stdout: "", stderr: redactSecrets(e?.message ?? String(e)), exitCode: 1 };
      }
    }, { body: t.Object({
      name: t.String(),
      vars: t.Optional(t.Record(t.String(), t.String())),
      gui: t.Optional(t.Boolean()),
      timeout: t.Optional(t.Number()),
    }) })
    .post("/shell", async ({ request }) => {
      const cmd = await request.text();
      if (!cmd) return { ok: false, stdout: "", stderr: "Empty command", exitCode: 1 };
      try {
        // /shell never took the UI lock (it still doesn't), but it runs in this server's queue so a lease
        // acquired meanwhile can't start while a shell command is running, and vice versa.
        return await guarded("shell", request, "shell", () => runPowerShellInline(cmd, { timeout: 60_000 }), {
          fileLock: false,
        });
      } catch (e: any) {
        return { ok: false, stdout: "", stderr: redactSecrets(e?.message ?? String(e)), exitCode: 1 };
      }
    })
    .post("/screenshot", async ({ query: { window, process: proc, foreground, crop, maxw }, request }) => {
      try {
        const opts = {
          window,
          process: proc,
          foreground: foreground === undefined ? undefined : !(foreground === "0" || foreground === "false"),
          crop,
          maxWidth: maxw ? parseInt(maxw, 10) : undefined,
        };
        // Targeting a window changes focus/foreground → serialize through the UI lock, and under a lease it
        // is a mutation like any other (guard "screenshot-window"). A full-screen capture stays outside.
        const capture = () => takeScreenshot(opts);
        const shot = (window || proc) ? await guarded("screenshot-window", request, "screenshot", capture) : await capture();
        if (shot instanceof Response) return shot; // 423: another owner holds a UI lease
        const pngPath = shot;
        const buf = await Bun.file(pngPath).arrayBuffer();
        return new Response(buf, { headers: { "Content-Type": "image/png", "X-Screenshot-Path": pngPath } });
      } catch (e) {
        return new Response(String(e), { status: 500 });
      }
    }, { query: t.Object({
      window: t.Optional(t.String()),
      process: t.Optional(t.String()),
      foreground: t.Optional(t.String()),
      crop: t.Optional(t.String()),
      maxw: t.Optional(t.String()),
    }) })
    .post("/redeploy", () => {
      console.log("[redeploy] exiting in 200ms — supervisor will restart");
      setTimeout(() => process.exit(2), 200);
      return { ok: true, message: "exiting in 200ms" };
    })
    .post("/ocr", async ({ query: { lang }, request }) => {
      // Body: raw PNG/JPEG bytes  OR  JSON {path: "C:\\..."}
      const contentType = request.headers.get("content-type") ?? "";
      let imagePath: string;
      if (contentType.includes("application/json")) {
        const body = await request.json() as { path?: string };
        if (!body.path) return Response.json({ ok: false, error: "missing path" }, { status: 400 });
        imagePath = body.path;
      } else {
        // Save uploaded image bytes to a temp file
        const buf = await request.arrayBuffer();
        imagePath = `C:\\tmp\\ocr-input-${Date.now()}.png`;
        await Bun.write(imagePath, buf);
      }
      try {
        const result = await runOcr(imagePath, lang ?? "ch");
        return result;
      } catch (e: any) {
        return Response.json({ ok: false, error: redactSecrets(e?.message ?? String(e)) }, { status: 500 });
      }
    }, { query: t.Object({ lang: t.Optional(t.String()) }) })
    .get("/ocr-stream", ({ query: { window, process: proc, crop, lang, interval, maxw }, request }) => {
      // Streaming OCR diff: poll on the host, emit only changed text boxes as SSE.
      //   data: + x1 y1 x2 y2 "text"   (box appeared)
      //   data: - x1 y1 x2 y2 "text"   (box disappeared)
      // Uses a warm OCR worker (model stays loaded) and passive capture
      // (foreground=0) so it doesn't steal focus from the live game.
      const worker = getOcrWorker(lang ?? "en");
      const shotOpts = {
        window, process: proc, crop, foreground: false,
        maxWidth: maxw ? parseInt(maxw, 10) : undefined,
      };
      const tickMs = interval ? parseInt(interval, 10) : 400;
      const enc = new TextEncoder();
      let prev: OcrBox[] = [];
      const stream = new ReadableStream({
        async start(controller) {
          const send = (s: string) => controller.enqueue(enc.encode(s));
          send(`event: ready\ndata: ocr-stream lang=${lang ?? "en"} interval=${tickMs}ms\n\n`);
          try {
            while (!request.signal.aborted) {
              let path: string;
              try {
                path = await takeScreenshot(shotOpts);
              } catch (e) {
                send(`event: error\ndata: ${String(e).replace(/\n/g, " ")}\n\n`);
                await Bun.sleep(tickMs);
                continue;
              }
              const { boxes } = await worker.recognize(path);
              const { added, removed } = diffBoxes(prev, boxes);
              // Row context: other boxes on the same line (y-center within
              // tolerance), left→right — so "39%" reads as its whole field/row.
              const rowCtx = (t: OcrBox, frame: OcrBox[]) => {
                const cy = (t.y1 + t.y2) / 2, tol = Math.max(12, (t.y2 - t.y1) * 0.5);
                return frame
                  .filter((b) => Math.abs((b.y1 + b.y2) / 2 - cy) <= tol)
                  .sort((a, b) => a.x1 - b.x1)
                  .map((b) => b.text)
                  .join(" ");
              };
              for (const b of removed) send(`data: - ${b.x1} ${b.y1} ${b.x2} ${b.y2} ${JSON.stringify(b.text)} «${rowCtx(b, prev)}»\n\n`);
              for (const b of added) send(`data: + ${b.x1} ${b.y1} ${b.x2} ${b.y2} ${JSON.stringify(b.text)} «${rowCtx(b, boxes)}»\n\n`);
              prev = boxes;
              await Bun.sleep(tickMs);
            }
          } catch { /* client gone / worker died */ }
          finally { try { controller.close(); } catch {} }
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "connection": "keep-alive" },
      });
    }, { query: t.Object({
      window: t.Optional(t.String()),
      process: t.Optional(t.String()),
      crop: t.Optional(t.String()),
      lang: t.Optional(t.String()),
      interval: t.Optional(t.String()),
      maxw: t.Optional(t.String()),
    }) });
}
