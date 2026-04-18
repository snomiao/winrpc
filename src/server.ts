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
import { readLockState, forceUnlockUi, acquireUiLock } from "./ui-lock";

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
    .post("/ahk-eval", async ({ query: { gui }, request }) => {
      const script = await request.text();
      if (!script) return { ok: false, stdout: "", stderr: "Empty script", exitCode: 1 };
      return withUiQueue("ahk-eval", () => runAhk(script, { gui: gui === "1" || gui === "true" }));
    }, { query: t.Object({ gui: t.Optional(t.String()) }) })
    .post("/run-template", async ({ body }) => {
      try {
        const script = ahkTemplate(body.name, body.vars ?? {});
        return withUiQueue(
          `run-template:${body.name}`,
          () => runAhk(script, { gui: !!body.gui, timeout: body.timeout }),
        );
      } catch (e: any) {
        return { ok: false, stdout: "", stderr: `template error: ${e?.message ?? e}`, exitCode: 1 };
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
      return runPowerShellInline(cmd, { timeout: 60_000 });
    })
    .post("/screenshot", async () => {
      try {
        const pngPath = await takeScreenshot();
        const buf = await Bun.file(pngPath).arrayBuffer();
        return new Response(buf, { headers: { "Content-Type": "image/png", "X-Screenshot-Path": pngPath } });
      } catch (e) {
        return new Response(String(e), { status: 500 });
      }
    })
    .post("/redeploy", () => {
      console.log("[redeploy] exiting in 200ms — supervisor will restart");
      setTimeout(() => process.exit(2), 200);
      return { ok: true, message: "exiting in 200ms" };
    });
}
