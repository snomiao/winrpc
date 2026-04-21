/**
 * AHK v2 execution helpers.
 *
 * - ahkEscape / ahkTemplate  — string escaping + template file loading
 * - runAhk                   — execute a script locally (IS_WIN required)
 *
 * Template directory: resolved from AHK_TEMPLATES_DIR env, or <cwd>/ahk/.
 * Template files: <dir>/<name>.template.ahk  (or <dir>/<name>.ahk for static)
 *
 * Magic substitution vars (no caller action needed):
 *   {{FIND_WECHAT}}          → find-wechat.template.ahk
 *   {{FIND_WECHAT_READONLY}} → find-wechat-readonly.template.ahk
 *   {{FIND_WECHAT_PASSIVE}}  → find-wechat-passive.template.ahk
 *   {{UIA_HELPERS}}          → uia-helpers.template.ahk
 */

import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { mkdirSync, writeFileSync, unlinkSync } from "fs";

const IS_WIN = process.platform === "win32";
const AHK_EXE = process.env.AHK_EXE ?? "C:\\Program Files\\AutoHotkey\\v2\\AutoHotkey64.exe";

export function ahkEscape(s: string, opts: { multiline?: boolean } = {}): string {
  let r = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, "``");
  if (opts.multiline) r = r.replace(/\r\n/g, "`n").replace(/\r/g, "`n").replace(/\n/g, "`n");
  return r;
}

function getTemplateDir(): string {
  return process.env.AHK_TEMPLATES_DIR ?? join(process.cwd(), "ahk");
}

const _tplCache = new Map<string, string>();
const _tplMtimes = new Map<string, number>();

function loadTemplate(dir: string, name: string): string {
  // Try <name>.template.ahk first, then <name>.ahk
  const candidates = [`${name}.template.ahk`, `${name}.ahk`];
  let path = "";
  for (const c of candidates) {
    const p = join(dir, c);
    if (existsSync(p)) { path = p; break; }
  }
  if (!path) throw new Error(`AHK template not found: ${name} (looked in ${dir})`);

  const mtime = statSync(path).mtimeMs;
  if (_tplCache.has(name) && _tplMtimes.get(name) === mtime) return _tplCache.get(name)!;
  const text = readFileSync(path, "utf-8");
  _tplCache.set(name, text);
  _tplMtimes.set(name, mtime);
  return text;
}

// AHK v2 (2.0.14+) enables #Warn VarUnset by default. _PrintErr is called in
// many templates but never formally defined — add a stub so AHK doesn't pause.
const _AHK_PREAMBLE = [
  `_PrintErr(msg) {`,
  `  FileAppend msg, "**"`,
  `}`,
  `_Print(msg) {`,
  `  FileAppend msg, "*"`,
  `}`,
  // Route runtime errors (thrown Error objects) to stderr and exit instead
  // of showing a modal dialog that would deadlock the UI queue.
  `OnError((e, mode) => (FileAppend("ERROR: " e.Message "\`n" (e.HasProp("Stack") ? e.Stack : "") "\`n", "**"), ExitApp(1), -1))`,
  ``,
].join("\n");

export function ahkTemplate(name: string, vars: Record<string, string> = {}): string {
  const dir = getTemplateDir();
  // Pre-load builtins so substitution order is predictable.
  const builtins = ["find-wechat-readonly", "find-wechat-passive", "find-wechat", "uia-helpers"];
  for (const b of builtins) {
    try { loadTemplate(dir, b); } catch { /* optional — only substitute if present */ }
  }

  let tpl = _AHK_PREAMBLE + loadTemplate(dir, name);
  // Longer-prefix variants first (they contain {{FIND_WECHAT}} as substring).
  if (_tplCache.has("find-wechat-readonly")) tpl = tpl.replaceAll("{{FIND_WECHAT_READONLY}}", _tplCache.get("find-wechat-readonly")!);
  if (_tplCache.has("find-wechat-passive"))  tpl = tpl.replaceAll("{{FIND_WECHAT_PASSIVE}}",  _tplCache.get("find-wechat-passive")!);
  if (_tplCache.has("find-wechat"))          tpl = tpl.replaceAll("{{FIND_WECHAT}}",          _tplCache.get("find-wechat")!);
  if (_tplCache.has("uia-helpers"))          tpl = tpl.replaceAll("{{UIA_HELPERS}}",          _tplCache.get("uia-helpers")!);
  for (const [k, v] of Object.entries(vars)) tpl = tpl.replaceAll(`{{${k}}}`, v);
  return tpl;
}

export async function runAhk(
  script: string,
  opts: { timeout?: number; gui?: boolean } = {},
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  const winrpcUrl = process.env.WINRPC_URL;
  if (winrpcUrl) {
    const timeout = opts.timeout ?? 30_000;
    const url = `${winrpcUrl.replace(/\/$/, "")}/ahk-eval`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: script,
        signal: controller.signal,
      });
      return await res.json() as { ok: boolean; stdout: string; stderr: string; exitCode: number };
    } finally {
      clearTimeout(timer);
    }
  }
  if (!IS_WIN) throw new Error("runAhk requires Windows (or set WINRPC_URL for remote)");
  const timeout = opts.timeout ?? 30_000;
  const tmpDir = "C:\\tmp";
  mkdirSync(tmpDir, { recursive: true });
  const scriptPath = `${tmpDir}\\ahk-eval-${Date.now()}-${Math.random().toString(36).slice(2)}.ahk`;
  writeFileSync(scriptPath, script, "utf-8");

  // /ErrorStdOut sends compile errors to stderr instead of a GUI dialog
  const args = opts.gui
    ? [AHK_EXE, "/ErrorStdOut", scriptPath]
    : [AHK_EXE, "/CP65001", "/ErrorStdOut", scriptPath];
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeout);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  try { unlinkSync(scriptPath); } catch {}
  return { ok: exitCode === 0, stdout, stderr, exitCode };
}
