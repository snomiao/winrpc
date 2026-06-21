/**
 * win-automation-server — generic Windows UI automation HTTP server.
 *
 * Endpoints:
 *   GET  /health              — uptime check
 *   GET  /version             — git commit + platform
 *   GET  /lock                — current UI lock state
 *   POST /lock/force-unlock   — admin: force-release the UI lock
 *   POST /ahk-eval            — execute AHK v2 script (body = script text)
 *   POST /run-template        — execute named AHK template (body = {name, vars?, gui?, timeout?})
 *   POST /shell               — execute PowerShell inline (body = command text)
 *   POST /screenshot          — take screenshot, return PNG bytes
 *   POST /redeploy            — exit(2) so supervisor restarts with latest code
 *
 * UI mutex: all /ahk-eval and /run-template requests are serialized via an
 * in-process async queue (+ cross-process file lock at C:\tmp\im-ui.lock).
 * Multiple clients (wx-cli, qq-cli, …) all share the same lock file.
 */

import { AsyncLocalStorage } from "async_hooks";
import { Elysia, t } from "elysia";
import { runAhk, ahkTemplate } from "./ahk";
import { runPowerShellInline } from "./powershell";
import { takeScreenshot } from "./screenshot";
import { runOcr, getOcrWorker, diffBoxes, type OcrBox } from "./ocr";
import { readLockState, forceUnlockUi, acquireUiLock } from "./ui-lock";
import { checkAuth } from "./auth";

// ── In-process UI serialization queue ────────────────────────────────────────
// Serializes concurrent requests within this server process. The cross-process
// file lock (ui-lock.ts) handles coordination between separate processes.
const _lockCtx = new AsyncLocalStorage<string>();
let _queue: Promise<unknown> = Promise.resolve();

function withUiQueue<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (_lockCtx.getStore()) return fn(); // reentrant — already in queue
  const next = _queue.then(async () => {
    const fileLock = await acquireUiLock(label, { timeoutMs: 60_000 });
    try { return await _lockCtx.run(label, fn); }
    finally { fileLock.release(); }
  });
  _queue = next.catch(() => undefined);
  return next;
}

// ── App ───────────────────────────────────────────────────────────────────────
export function makeApp() {
  return new Elysia()
    .onError(({ error }) => {
      // Let Response errors (e.g. 401 from auth) pass through unchanged.
      if (error instanceof Response) return error;
      // Return all other unhandled errors as JSON so clients can parse consistently.
      const msg = error instanceof Error ? error.message : String(error);
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
        ? { locked: true, holder: state.holder, pid: state.pid, host: state.host, expiresIn: Math.max(0, state.expiresAt - Date.now()) }
        : { locked: false };
    })
    .post("/lock/force-unlock", () => {
      const prev = forceUnlockUi();
      return { ok: true, released: prev ?? null };
    })
    .post("/ahk-eval", async ({ query: { gui, readonly }, request }) => {
      const script = await request.text();
      if (!script) return { ok: false, stdout: "", stderr: "Empty script", exitCode: 1 };
      const run = () => runAhk(script, { gui: gui === "1" || gui === "true" });
      // read-only probes (uia-pwd, uia-chats-sidebar) bypass the UI lock
      try {
        return await (readonly === "1" ? run() : withUiQueue("ahk-eval", run));
      } catch (e: any) {
        return { ok: false, stdout: "", stderr: e?.message ?? String(e), exitCode: 1 };
      }
    }, { query: t.Object({ gui: t.Optional(t.String()), readonly: t.Optional(t.String()) }) })
    .post("/run-template", async ({ body }) => {
      try {
        const script = ahkTemplate(body.name, body.vars ?? {});
        return await withUiQueue(
          `run-template:${body.name}`,
          () => runAhk(script, { gui: !!body.gui, timeout: body.timeout }),
        );
      } catch (e: any) {
        return { ok: false, stdout: "", stderr: e?.message ?? String(e), exitCode: 1 };
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
        return await runPowerShellInline(cmd, { timeout: 60_000 });
      } catch (e: any) {
        return { ok: false, stdout: "", stderr: e?.message ?? String(e), exitCode: 1 };
      }
    })
    .post("/screenshot", async ({ query: { window, process: proc, foreground, crop, maxw } }) => {
      try {
        const opts = {
          window,
          process: proc,
          foreground: foreground === undefined ? undefined : !(foreground === "0" || foreground === "false"),
          crop,
          maxWidth: maxw ? parseInt(maxw, 10) : undefined,
        };
        // Targeting a window changes focus/foreground → serialize through the UI lock.
        const capture = () => takeScreenshot(opts);
        const pngPath = (window || proc) ? await withUiQueue("screenshot", capture) : await capture();
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
        return Response.json({ ok: false, error: e?.message ?? String(e) }, { status: 500 });
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
              for (const b of removed) send(`data: - ${b.x1} ${b.y1} ${b.x2} ${b.y2} ${JSON.stringify(b.text)}\n\n`);
              for (const b of added) send(`data: + ${b.x1} ${b.y1} ${b.x2} ${b.y2} ${JSON.stringify(b.text)}\n\n`);
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
