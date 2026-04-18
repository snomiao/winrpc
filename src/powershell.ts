import { mkdirSync, writeFileSync, unlinkSync } from "fs";

export async function runPowerShell(
  script: string,
  opts: { timeout?: number } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  const timeout = opts.timeout ?? 60_000;
  const tmpDir = process.platform === "win32" ? "C:\\tmp" : "/tmp";
  mkdirSync(tmpDir, { recursive: true });
  const psFile = `${tmpDir}\\ps-${Date.now()}.ps1`;
  writeFileSync(psFile, script, "utf-8");
  const proc = Bun.spawn(
    ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", psFile],
    { stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => proc.kill(), timeout);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  try { unlinkSync(psFile); } catch {}
  return { ok: exitCode === 0, stdout, stderr, exitCode };
}

/** Run an inline PowerShell one-liner (no temp file). 60s timeout. */
export async function runPowerShellInline(
  cmd: string,
  opts: { timeout?: number } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  const timeout = opts.timeout ?? 60_000;
  const proc = Bun.spawn(
    ["powershell", "-NoProfile", "-NonInteractive", "-Command", cmd],
    { stdout: "pipe", stderr: "pipe" },
  );
  const killer = setTimeout(() => proc.kill(), timeout);
  const [stdout, stderr, exitCode] = await Promise.race([
    Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]),
    new Promise<never>((_, reject) => setTimeout(() => { proc.kill(); reject(new Error("shell timeout")); }, timeout)),
  ]);
  clearTimeout(killer);
  return { ok: exitCode === 0, stdout, stderr, exitCode };
}
