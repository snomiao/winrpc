import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Isolated lock file and a fake token, set before the server (and auth.ts) load.
const dir = mkdtempSync(join(tmpdir(), "winrpc-lease-"));
process.env.IM_UI_LOCK_PATH = join(dir, "im-ui.lock");
// The tests send "MsgBox 1" to /ahk-eval and only look at the lease decision (423 or not). On a host
// with AutoHotkey at its default path that would open a real dialog and block for the AHK timeout, so
// point AHK_EXE at a file that does not exist: the spawn fails at once, like on a host without AHK.
process.env.AHK_EXE = join(dir, "no-autohotkey.exe");
process.env.WINRPC_TOKEN = "test-token-0123456789abcdef";
delete process.env.WINRPC_URL;
delete process.env.WINRPC_LEASE_GUARDS;

const { makeApp, _enqueue } = await import("../src/server");
const { acquireLease, dropLease, gate, releaseLease, MAX_TTL_MS } = await import("../src/lease");
const { acquireUiLock, readLockState, forceUnlockUi: forceUnlockFile } = await import("../src/ui-lock");

const app = makeApp();
const auth = { authorization: `Bearer ${process.env.WINRPC_TOKEN}` };

async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const isText = typeof body === "string";
  const res = await app.handle(
    new Request(`http://local${path}`, {
      method,
      headers: { ...auth, ...(body === undefined ? {} : { "content-type": isText ? "text/plain" : "application/json" }), ...headers },
      body: body === undefined ? undefined : isText ? body : JSON.stringify(body),
    }),
  );
  const txt = await res.text();
  let json: any;
  try { json = JSON.parse(txt); } catch { json = { text: txt }; }
  return { status: res.status, body: json };
}

const acquire = (owner: string, extra: Record<string, unknown> = {}) => call("POST", "/lock/acquire", { owner, ...extra });

beforeEach(() => {
  dropLease();
  delete process.env.WINRPC_LEASE_GUARDS;
});
afterAll(() => {
  dropLease();
  rmSync(dir, { recursive: true, force: true });
});

describe("UI lease", () => {
  test("acquire returns a lease; /lock shows the owner and expiry but never the lease id", async () => {
    const a = await acquire("flow-a", { label: "file picker", ttl_ms: 60_000 });
    expect(a.status).toBe(200);
    expect(a.body.lease).toMatch(/^[0-9a-f]{32}$/);
    const lock = await call("GET", "/lock");
    expect(lock.body.locked).toBe(true);
    expect(lock.body.lease).toMatchObject({ owner: "flow-a", label: "file picker" });
    expect(JSON.stringify(lock.body)).not.toContain(a.body.lease);
  });

  test("another owner gets 423 {holder, expires_at} on mutating endpoints; /screenshot stays outside", async () => {
    const a = await acquire("flow-a");
    for (const [path, body] of [
      ["/ahk-eval", "MsgBox 1"],
      ["/run-template", { name: "nope" }],
      ["/shell", "Get-Date"],
    ] as const) {
      const r = await call("POST", path, body);
      if (path === "/run-template") {
        // template rendering fails before the gate on this machine (no ahk/ dir); it must not run either way
        expect(r.status === 423 || r.body.ok === false).toBe(true);
        continue;
      }
      expect(r.status).toBe(423);
      expect(r.body).toMatchObject({ holder: "flow-a", expires_at: a.body.expires_at });
    }
    const shot = await call("POST", "/screenshot");
    expect(shot.status).not.toBe(423);
    // a window capture brings the window to the front: guarded ("screenshot-window")
    const win = await call("POST", "/screenshot?window=Notepad");
    expect(win.status).toBe(423);
    expect(win.body).toMatchObject({ holder: "flow-a" });
    // a second acquire by someone else is refused with the same info
    const b = await acquire("flow-b");
    expect(b.status).toBe(423);
    expect(b.body.holder).toBe("flow-a");
  });

  test("the holder passes and does not contend for the per-request lock again (rail 1)", async () => {
    const a = await acquire("flow-a");
    const t0 = Date.now();
    const r = await call("POST", "/ahk-eval", "MsgBox 1", { "x-winrpc-lease": a.body.lease });
    // Not 423 and no 60 s wait for the file lock the lease itself holds (runAhk then fails off Windows).
    expect(r.status).not.toBe(423);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r.body.stderr ?? "").not.toContain("UI lock timeout");
    // the lock file is still the lease's
    expect(readLockState()?.holder).toBe("lease:flow-a");
  });

  test("a wrong lease id is treated as another owner", async () => {
    await acquire("flow-a");
    const r = await call("POST", "/ahk-eval", "MsgBox 1", { "x-winrpc-lease": "0".repeat(32) });
    expect(r.status).toBe(423);
  });

  test("renew extends, capped at MAX_TTL_MS; release ends it; a second release is 410", async () => {
    const a = await acquire("flow-a", { ttl_ms: 5_000 });
    const r = await call("POST", "/lock/renew", { lease: a.body.lease, ttl_ms: 10 * MAX_TTL_MS });
    expect(r.status).toBe(200);
    const left = Date.parse(r.body.expires_at) - Date.now();
    expect(left).toBeGreaterThan(MAX_TTL_MS - 5_000);
    expect(left).toBeLessThanOrEqual(MAX_TTL_MS);
    expect((await call("POST", "/lock/renew", { lease: "x".repeat(32) })).status).toBe(410);
    expect((await call("POST", "/lock/release", { lease: a.body.lease })).status).toBe(200);
    expect((await call("POST", "/lock/release", { lease: a.body.lease })).status).toBe(410);
    expect(existsSync(process.env.IM_UI_LOCK_PATH!)).toBe(false);
    // free again: no 423
    expect((await call("POST", "/ahk-eval", "MsgBox 1")).status).not.toBe(423);
  });

  test("auto-release when the holder stops renewing (rail 2)", async () => {
    const a = await acquire("flow-a", { ttl_ms: 1_000 });
    expect(a.status).toBe(200);
    await Bun.sleep(1_300);
    expect((await call("GET", "/lock")).body.lease).toBeNull();
    expect((await call("POST", "/ahk-eval", "MsgBox 1")).status).not.toBe(423);
    expect((await call("POST", "/lock/renew", { lease: a.body.lease })).status).toBe(410);
    const b = await acquire("flow-b");
    expect(b.status).toBe(200);
  });

  test("if the server dies, the lock file still expires, so other processes take over (rail 2)", async () => {
    await acquire("flow-a", { ttl_ms: 1_000 });
    // simulate another process waiting for the file lock, past the lease's expiry
    const h = await acquireUiLock("other-process", { timeoutMs: 3_000 });
    expect(readLockState()?.holder).toBe("other-process");
    h.release();
  });

  test("force-unlock ends the lease too", async () => {
    await acquire("flow-a");
    const r = await call("POST", "/lock/force-unlock");
    expect(r.body.lease).toMatchObject({ owner: "flow-a" });
    expect((await call("GET", "/lock")).body.lease).toBeNull();
  });

  test("guards are configuration: WINRPC_LEASE_GUARDS without shell lets /shell through", async () => {
    await acquire("flow-a");
    process.env.WINRPC_LEASE_GUARDS = "ahk-eval,run-template";
    expect((await call("POST", "/shell", "Get-Date")).status).not.toBe(423);
    expect((await call("POST", "/ahk-eval", "MsgBox 1")).status).toBe(423);
  });
});

describe("lease edge cases (codex round 1)", () => {
  test("a holder whose lease expired before its turn is not a holder any more (no lock bypass)", async () => {
    const a = (await acquireLease({ owner: "flow-a", ttlMs: 1_000 })) as any;
    await Bun.sleep(1_200);
    expect(gate(a.lease).kind).toBe("free"); // -> takes the per-request lock like everyone else
  });

  test("expiry during a running holder action keeps the lock until the action ends", async () => {
    const a = (await acquireLease({ owner: "flow-a", ttlMs: 1_000 })) as any;
    const g = gate(a.lease);
    expect(g.kind).toBe("holder");
    await Bun.sleep(1_300); // the lease's TTL passes while the action "runs"
    // still locked for other processes (the file lock was extended), not stealable
    await expect(acquireUiLock("other-process", { timeoutMs: 300 })).rejects.toThrow(/UI lock timeout/);
    expect(readLockState()?.holder).toBe("lease:flow-a");
    // a new lease can't start yet either
    expect("held" in (await acquireLease({ owner: "flow-b", waitMs: 0 }))).toBe(true);
    (g as any).done();
    expect(existsSync(process.env.IM_UI_LOCK_PATH!)).toBe(false);
    expect("lease" in (await acquireLease({ owner: "flow-b" }))).toBe(true);
  });

  test("release during the holder's own running action frees the lock only when it ends", async () => {
    const a = (await acquireLease({ owner: "flow-a", ttlMs: 60_000 })) as any;
    const g = gate(a.lease);
    expect(releaseLease(a.lease)).toBe(true);
    expect(readLockState()?.holder).toBe("lease:flow-a");
    (g as any).done();
    expect(existsSync(process.env.IM_UI_LOCK_PATH!)).toBe(false);
  });

  test("a lease that had to wait for the lock starts its lifetime when it gets it", async () => {
    const other = await acquireUiLock("other-process", { ttlMs: 60_000 });
    setTimeout(() => other.release(), 1_500);
    const t0 = Date.now();
    const a = (await acquireLease({ owner: "flow-a", ttlMs: 1_000, waitMs: 5_000 })) as any;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1_400);
    expect(a.lease).toBeDefined();
    expect(Date.parse(a.expires_at)).toBeGreaterThan(Date.now());
    expect(readLockState()!.expiresAt).toBe(Date.parse(a.expires_at));
  });

  test("a request from another owner is decided at its turn: blocked once a lease exists", async () => {
    expect(gate(null).kind).toBe("free");
    await acquireLease({ owner: "flow-a" });
    const g = gate(null);
    expect(g.kind).toBe("blocked");
    expect((g as any).info.owner).toBe("flow-a");
  });

  test("/shell is decided in the queue too: 423 for another owner, runs for the holder", async () => {
    const a = await acquire("flow-a");
    expect((await call("POST", "/shell", "Get-Date")).status).toBe(423);
    expect((await call("POST", "/shell", "Get-Date", { "x-winrpc-lease": a.body.lease })).status).not.toBe(423);
  });
});

describe("lease edge cases (codex round 2)", () => {
  test("renew never overwrites a lock another holder took over", async () => {
    const mine = await acquireUiLock("me", { ttlMs: 300 });
    await Bun.sleep(400);
    const other = await acquireUiLock("other-process", { timeoutMs: 1_000, ttlMs: 60_000 }); // steals the expired lock
    expect(mine.renew(60_000)).toBe(false);
    expect(readLockState()?.holder).toBe("other-process");
    other.release();
  });

  test("a holder action is protected from its first moment, past the lease's expiry", async () => {
    const a = (await acquireLease({ owner: "flow-a", ttlMs: 1_000 })) as any;
    const g = gate(a.lease);
    // the heartbeat already put the file lock ~60 s ahead, before any expiry
    expect(readLockState()!.expiresAt - Date.now()).toBeGreaterThan(55_000);
    await Bun.sleep(1_200);
    await expect(acquireUiLock("other-process", { timeoutMs: 300 })).rejects.toThrow(/UI lock timeout/);
    (g as any).done();
    expect(existsSync(process.env.IM_UI_LOCK_PATH!)).toBe(false);
  });

  test("renewing during an action never shortens the lock below the heartbeat margin", async () => {
    const a = (await acquireLease({ owner: "flow-a", ttlMs: 60_000 })) as any;
    const g = gate(a.lease);
    await call("POST", "/lock/renew", { lease: a.lease, ttl_ms: 1_000 });
    expect(readLockState()!.expiresAt - Date.now()).toBeGreaterThan(55_000);
    (g as any).done();
  });

  test("wait_ms counts the time in the queue: 423 at the deadline, and no lease appears later", async () => {
    const busy = _enqueue(() => Bun.sleep(1_500));
    const t0 = Date.now();
    const r = await acquire("flow-late", { wait_ms: 200 });
    expect(r.status).toBe(423);
    expect(Date.now() - t0).toBeLessThan(1_000);
    await busy;
    await Bun.sleep(50);
    expect((await call("GET", "/lock")).body.lease).toBeNull();
  });
});

describe("lease edge cases (codex round 3)", () => {
  test("a lost lock ends the lease: renew answers 410, the next request is not a holder", async () => {
    const a = (await acquireLease({ owner: "flow-a", ttlMs: 60_000 })) as any;
    forceUnlockFile(); // another process "took over" the file
    const other = await acquireUiLock("other-process", { ttlMs: 60_000 });
    expect((await call("POST", "/lock/renew", { lease: a.lease })).status).toBe(410);
    expect(readLockState()?.holder).toBe("other-process");
    other.release();
  });

  test("a lost lock at the start of an action: not admitted as holder", async () => {
    const a = (await acquireLease({ owner: "flow-a", ttlMs: 60_000 })) as any;
    forceUnlockFile();
    const other = await acquireUiLock("other-process", { ttlMs: 60_000 });
    expect(gate(a.lease).kind).toBe("free");
    expect(readLockState()?.holder).toBe("other-process");
    other.release();
  });

  test("with ahk-eval not guarded, the holder still runs inside its lease (no wait on its own lock)", async () => {
    const a = await acquire("flow-a");
    process.env.WINRPC_LEASE_GUARDS = "shell";
    const t0 = Date.now();
    const r = await call("POST", "/ahk-eval", "MsgBox 1", { "x-winrpc-lease": a.body.lease });
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r.body.stderr ?? "").not.toContain("UI lock timeout");
  });
});

describe("CTO review (luna) on 7926a5c", () => {
  test("a non-holder on an unguarded endpoint passes at once while a lease is held (no wait on its lock)", async () => {
    await acquire("flow-a");
    process.env.WINRPC_LEASE_GUARDS = "shell";
    const t0 = Date.now();
    const r = await call("POST", "/ahk-eval", "MsgBox 1");
    expect(r.status).not.toBe(423);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r.body.stderr ?? "").not.toContain("UI lock timeout");
    // the lease is untouched
    expect(readLockState()?.holder).toBe("lease:flow-a");
  });
});

describe("CLI with a running server", () => {
  test("lock acquire → ahk-repl without the lease exits 75 naming the holder → lock release", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "winrpc-cli-"));
    const port = 20000 + Math.floor(Math.random() * 20000);
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: cwd,
      IM_UI_LOCK_PATH: join(cwd, "im-ui.lock"),
      WINRPC_TOKEN: "cli-test-token-0123456789abcdef",
      AHK_EXE: join(cwd, "no-autohotkey.exe"), // see the top of this file
    };
    const entry = join(import.meta.dir, "../src/index.ts");
    const server = Bun.spawn(["bun", entry, "serve", "--host", "127.0.0.1", "--port", String(port)], {
      cwd, env, stdout: "pipe", stderr: "pipe",
    });
    const cli = (args: string[], extra: Record<string, string> = {}) => {
      const p = Bun.spawnSync(["bun", entry, ...args, "--url", `http://127.0.0.1:${port}`], {
        cwd, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe",
      });
      return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
    };
    try {
      for (let i = 0; i < 50 && cli(["lock"]).code !== 0; i++) await Bun.sleep(200);
      const a = cli(["lock", "acquire", "--owner", "flow-cli", "--label", "test", "--ttl", "60"]);
      expect(a.code).toBe(0);
      const lease = JSON.parse(a.out).lease as string;
      expect(lease).toMatch(/^[0-9a-f]{32}$/);
      const repl = (extra: Record<string, string> = {}) => {
        const p = Bun.spawnSync(["bun", entry, "ahk-repl", `http://127.0.0.1:${port}`], {
          cwd, env: { ...env, ...extra }, stdin: new TextEncoder().encode("MsgBox 1\n"), stdout: "pipe", stderr: "pipe",
        });
        return { code: p.exitCode, err: p.stderr.toString() };
      };
      const blocked = repl();
      expect(blocked.code).toBe(75);
      expect(blocked.err).toContain("ui lease held by flow-cli (test)");
      // with the lease (env), the request is let through (it then fails off Windows, but not 75)
      expect(repl({ WINRPC_LEASE: lease }).code).not.toBe(75);
      // a second owner trying to acquire gets the same temporary-failure exit
      const second = cli(["lock", "acquire", "--owner", "flow-other", "--wait", "0"]);
      expect(second.code).toBe(75);
      expect(second.err).toContain("ui lease held by flow-cli");
      expect(cli(["lock", "renew", lease, "--ttl", "30"]).code).toBe(0);
      expect(cli(["lock", "release", lease]).code).toBe(0);
      expect(JSON.parse(cli(["lock"]).out).lease).toBeNull();
    } finally {
      server.kill();
      await server.exited;
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 180_000); // starts a server and `bun` ~8 times
});
