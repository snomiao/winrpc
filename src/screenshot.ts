import { mkdirSync } from "fs";
import { join } from "path";
import { runPowerShellFile } from "./powershell";

const PS_DIR = join(import.meta.dir, "ps");

export interface ScreenshotOptions {
  /** Output PNG path. Defaults to a timestamped file under the temp dir. */
  outPath?: string;
  /** Capture only the window whose title contains this substring (case-insensitive). */
  window?: string;
  /** Capture only the window owned by a process with this name (e.g. "OxygenNotIncluded"). */
  process?: string;
  /** Bring the matched window to the foreground (and restore if minimized) before capture. Default true when targeting a window. */
  foreground?: boolean;
}

/**
 * Capture the full primary screen, or a specific window if `window`/`process`
 * is given. Returns the saved PNG path.
 *
 * The actual capture logic lives in src/ps/screenshot-screen.ps1 and
 * src/ps/screenshot-window.ps1; this just resolves the destination path and
 * invokes the right script with named args.
 */
export async function takeScreenshot(opts: ScreenshotOptions = {}): Promise<string> {
  const tmpDir = process.platform === "win32" ? "C:\\tmp" : "/tmp";
  mkdirSync(tmpDir, { recursive: true });
  const dest = opts.outPath ?? `${tmpDir}\\screenshot-${Date.now()}.png`;

  let r: Awaited<ReturnType<typeof runPowerShellFile>>;
  if (opts.window || opts.process) {
    const args = ["-Dest", dest];
    if (opts.process) args.push("-ProcName", opts.process);
    if (opts.window) args.push("-TitleMatch", opts.window);
    if (opts.foreground !== false) args.push("-Foreground"); // default true for window capture
    r = await runPowerShellFile(join(PS_DIR, "screenshot-window.ps1"), args, { timeout: 20_000 });
  } else {
    r = await runPowerShellFile(join(PS_DIR, "screenshot-screen.ps1"), ["-Dest", dest], { timeout: 20_000 });
  }

  if (!r.ok || !r.stdout.includes("screenshot-ok")) {
    const reason = r.stdout.match(/screenshot-err:(\S+)/)?.[1] ?? r.stderr;
    throw new Error(`Screenshot failed: ${reason}`);
  }
  return dest;
}
