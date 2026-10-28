import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Client subcommands, run as a real `winrpc` process against an in-process server.
const dir = mkdtempSync(join(tmpdir(), "winrpc-cli-"));
process.env.IM_UI_LOCK_PATH = join(dir, "im-ui.lock");
process.env.AHK_EXE = join(dir, "no-autohotkey.exe");
const TOKEN = "test-token-0123456789abcdef";
process.env.WINRPC_TOKEN = TOKEN;

const { makeApp } = await import("../src/server");
const app = makeApp().listen({ hostname: "127.0.0.1", port: 0 });
const URL_ = `http://${TOKEN}@127.0.0.1:${app.server!.port}`;
const CLI = join(import.meta.dir, "../src/index.ts");

afterAll(() => {
  app.stop();
  rmSync(dir, { recursive: true, force: true });
});

async function winrpc(args: string[], env: Record<string, string> = {}, stdin?: string) {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    cwd: dir,
    env: { PATH: process.env.PATH!, IM_UI_LOCK_PATH: process.env.IM_UI_LOCK_PATH!, WINRPC_URL: URL_, ...env },
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe("client subcommands", () => {
  test("health / version / lock print JSON", async () => {
    const h = await winrpc(["health"]);
    expect(h.code).toBe(0);
    expect(JSON.parse(h.stdout).ok).toBe(true);
    const v = await winrpc(["version"]);
    expect(v.code).toBe(0);
    expect(JSON.parse(v.stdout).platform).toBe(process.platform);
    expect(JSON.parse((await winrpc(["lock"])).stdout).locked).toBe(false);
  });

  test("--url overrides $WINRPC_URL; token falls back to $WINRPC_TOKEN", async () => {
    const r = await winrpc(["lock", "--url", `http://127.0.0.1:${app.server!.port}`], {
      WINRPC_URL: "http://127.0.0.1:1",
      WINRPC_TOKEN: TOKEN,
    });
    expect(r.code).toBe(0);
  });

  test("force-unlock drops another owner's lease", async () => {
    await winrpc(["lock", "acquire", "--owner", "other", "--ttl", "30"]);
    const r = await winrpc(["force-unlock"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).ok).toBe(true);
    expect(JSON.parse((await winrpc(["lock"])).stdout).lease).toBe(null);
  });

  test("ahk exits 75 while another owner holds a lease, runs with --lease", async () => {
    const lease = JSON.parse((await winrpc(["lock", "acquire", "--owner", "other", "--ttl", "30"])).stdout).lease;
    const held = await winrpc(["ahk", "x := 1"]);
    expect(held.code).toBe(75);
    expect(held.stderr).toContain("ui lease held by other");
    // With the lease the request is admitted; AHK_EXE does not exist, so the script itself fails (not 75).
    const own = await winrpc(["ahk", "--lease", lease, "x := 1"]);
    expect(own.code).not.toBe(75);
    expect(own.code).not.toBe(0);
    await winrpc(["lock", "release", lease]);
  });

  test("ahk without a script exits 2", async () => {
    const r = await winrpc(["ahk"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("ahk-repl");
  });

  test("unreachable server: one clean error line, exit 1", async () => {
    const r = await winrpc(["health", "--url", "http://127.0.0.1:1"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cannot reach winrpc at http://127.0.0.1:1");
    expect(r.stderr).not.toContain("Commands:");
  });

  test("client commands never print the token or create .env.local", async () => {
    for (const args of [["health"], ["lock"], ["ahk", "x := 1"], ["shell", "--help"]]) {
      const r = await winrpc(args);
      expect(r.stdout + r.stderr).not.toContain(TOKEN);
    }
    expect(existsSync(join(dir, ".env.local"))).toBe(false);
  });
});
