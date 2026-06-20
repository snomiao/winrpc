import { mkdirSync } from "fs";
import { runPowerShell } from "./powershell";

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

const psQuote = (s: string) => s.replace(/'/g, "''");
const psPath = (s: string) => s.replace(/\\/g, "\\\\");

/**
 * Capture the full primary screen, or a specific window if `window`/`process`
 * is given. Returns the saved PNG path.
 *
 * Window capture uses CopyFromScreen over the window's on-screen bounds (via
 * DWM extended frame bounds), which works for GPU-rendered apps/games where
 * PrintWindow returns black — so the window must be visible/unoccluded, hence
 * the default foreground bring-up.
 */
export async function takeScreenshot(opts: ScreenshotOptions = {}): Promise<string> {
  const tmpDir = process.platform === "win32" ? "C:\\tmp" : "/tmp";
  mkdirSync(tmpDir, { recursive: true });
  const dest = opts.outPath ?? `${tmpDir}\\screenshot-${Date.now()}.png`;
  const target = opts.window ?? opts.process;
  const ps = target ? windowPs(opts, dest) : fullScreenPs(dest);
  const r = await runPowerShell(ps, { timeout: 20_000 });
  if (!r.ok || !r.stdout.includes("screenshot-ok")) {
    const reason = r.stdout.match(/screenshot-err:(\S+)/)?.[1] ?? r.stderr;
    throw new Error(`Screenshot failed: ${reason}`);
  }
  return dest;
}

function fullScreenPs(dest: string): string {
  return `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save('${psPath(dest)}')
$g.Dispose(); $bmp.Dispose()
Write-Host "screenshot-ok:${psPath(dest)}"
`.trim();
}

function windowPs(opts: ScreenshotOptions, dest: string): string {
  const foreground = opts.foreground !== false; // default true for window capture
  // Resolve a process name to a PID; titles are matched across all top-level
  // windows. We can't rely on Process.MainWindowHandle — Unity games (e.g. ONI)
  // report 0 there — so we EnumWindows and pick the largest visible window
  // owned by the target PID and/or matching the title substring.
  const resolvePid = opts.process
    ? `$procId = (Get-Process -Name '${psQuote(opts.process)}' -ErrorAction SilentlyContinue | Select-Object -First 1).Id
if (-not $procId) { Write-Host "screenshot-err:process-not-found"; exit 1 }`
    : `$procId = 0`;
  const title = opts.window ? psQuote(opts.window) : "";
  return `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$sig = @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinShot {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int c);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  public static string LastTitle = "";
  public static IntPtr Find(int pid, string title) {
    IntPtr best = IntPtr.Zero; long bestArea = -1; string bestTitle = "";
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      uint wpid; GetWindowThreadProcessId(h, out wpid);
      if (pid != 0 && wpid != (uint)pid) return true;
      int len = GetWindowTextLength(h);
      StringBuilder sb = new StringBuilder(len + 2);
      GetWindowText(h, sb, sb.Capacity);
      string wt = sb.ToString();
      if (!string.IsNullOrEmpty(title) && wt.IndexOf(title, StringComparison.OrdinalIgnoreCase) < 0) return true;
      RECT r; GetWindowRect(h, out r);
      long area = (long)(r.Right - r.Left) * (r.Bottom - r.Top);
      if (area > bestArea) { bestArea = area; best = h; bestTitle = wt; }
      return true;
    }, IntPtr.Zero);
    LastTitle = bestTitle;
    return best;
  }
}
"@
Add-Type -TypeDefinition $sig
${resolvePid}
$h = [WinShot]::Find([int]$procId, '${title}')
if ($h -eq [IntPtr]::Zero) { Write-Host "screenshot-err:window-not-found"; exit 1 }
if ([WinShot]::IsIconic($h)) { [WinShot]::ShowWindow($h, 9) | Out-Null; Start-Sleep -Milliseconds 400 }
${foreground ? `[WinShot]::SetForegroundWindow($h) | Out-Null; Start-Sleep -Milliseconds 300` : ``}
$r = New-Object WinShot+RECT
$dwm = [WinShot]::DwmGetWindowAttribute($h, 9, [ref]$r, [System.Runtime.InteropServices.Marshal]::SizeOf($r))
if ($dwm -ne 0) { [WinShot]::GetWindowRect($h, [ref]$r) | Out-Null }
$w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
if ($w -le 0 -or $ht -le 0) { Write-Host "screenshot-err:bad-bounds"; exit 1 }
$bmp = New-Object System.Drawing.Bitmap($w, $ht)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, (New-Object System.Drawing.Size($w, $ht)))
$bmp.Save('${psPath(dest)}')
$g.Dispose(); $bmp.Dispose()
Write-Host "screenshot-ok:${psPath(dest)} title=$([WinShot]::LastTitle) size=${'$'}{w}x${'$'}{ht}"
`.trim();
}
