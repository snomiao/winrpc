import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { knownSecrets, mask, redactSecrets, redactUrl } from "../src/redact";

// A fake token: never a real one.
const TOKEN = "f00dfeedcafe0123456789abcdef0123456789abcdef0123456789abcdef0123";
const URL_WITH_TOKEN = `http://${TOKEN}@192.0.2.1:12371`;
const ENTRY = resolve(import.meta.dir, "../src/index.ts");

describe("redact", () => {
  test("redactUrl masks the user and password parts", () => {
    expect(redactUrl(`go to ${URL_WITH_TOKEN}/lock now`)).toBe("go to http://***@192.0.2.1:12371/lock now");
    expect(redactUrl("http://u:p@h:1/x")).toBe("http://***@h:1/x");
    expect(redactUrl("http://h:1/x")).toBe("http://h:1/x");
  });

  test("knownSecrets reads $WINRPC_TOKEN and the user part of $WINRPC_URL", () => {
    expect(knownSecrets({ WINRPC_URL: URL_WITH_TOKEN })).toEqual([TOKEN]);
    expect(knownSecrets({ WINRPC_TOKEN: ` ${TOKEN} ` })).toEqual([TOKEN]);
    expect(knownSecrets({ WINRPC_TOKEN: "short" })).toEqual([]);
  });

  test("redactSecrets masks the bare token too", () => {
    const out = redactSecrets(`Bearer ${TOKEN} and ${URL_WITH_TOKEN}`, [TOKEN]);
    expect(out).not.toContain(TOKEN);
    expect(out).toBe(`Bearer ${mask(TOKEN)} and http://***@192.0.2.1:12371`);
  });
});

describe("CLI output never shows the token", () => {
  const run = (args: string[], cwd: string) => {
    const p = Bun.spawnSync(["bun", ENTRY, ...args], {
      cwd,
      env: { PATH: process.env.PATH ?? "", HOME: cwd, WINRPC_URL: URL_WITH_TOKEN, WINRPC_TOKEN: TOKEN },
      stdout: "pipe",
      stderr: "pipe",
    });
    return p.stdout.toString() + p.stderr.toString();
  };

  test("--help of every client command, an invalid --url, and an unreachable server", () => {
    const cwd = mkdtempSync(join(tmpdir(), "winrpc-redact-"));
    try {
      const outputs = [
        run(["--help"], cwd),
        ...["ahk-repl", "lock"].map((c) => run([c, "--help"], cwd)),
        run(["lock", "--url", `http://${TOKEN}@[bad`], cwd),
        // a closed port: the error names the target without the token
        run(["lock", "--url", `http://${TOKEN}@127.0.0.1:9`], cwd),
      ];
      for (const o of outputs) {
        expect(o.length).toBeGreaterThan(0);
        // yargs wraps long help lines, so compare without whitespace, and look for any 12-char piece
        const flat = o.replace(/\s+/g, "");
        for (let i = 0; i + 12 <= TOKEN.length; i += 6) expect(flat).not.toContain(TOKEN.slice(i, i + 12));
      }
      // a client command does not create a token file in its working directory
      expect(existsSync(join(cwd, ".env.local"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 120_000); // starts `bun` 8 times
});
