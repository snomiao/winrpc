# Capture a single window to $Dest as PNG.
#
# Find the target window by owning process name (-ProcName) and/or a title
# substring (-TitleMatch), picking the largest visible top-level window. We
# enumerate windows rather than using Process.MainWindowHandle because some
# apps (Unity games such as Oxygen Not Included) report a 0 handle / empty
# title there.
#
# Capture is CopyFromScreen over the window's DWM extended-frame bounds, which
# works for GPU-rendered apps where PrintWindow returns black — so the window
# must be visible/unoccluded; pass -Foreground to bring it forward first.
param(
    [Parameter(Mandatory = $true)][string]$Dest,
    [string]$ProcName = "",
    [string]$TitleMatch = "",
    [switch]$Foreground,
    # -Crop "x,y,w,h" restricts capture to a rectangle relative to the window's
    # top-left. Values <= 1 are fractions of the window size; otherwise pixels.
    [string]$Crop = ""
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
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

$procId = 0
if ($ProcName -ne "") {
    $p = Get-Process -Name $ProcName -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $p) { Write-Host "screenshot-err:process-not-found"; exit 1 }
    $procId = $p.Id
}

$h = [WinShot]::Find([int]$procId, $TitleMatch)
if ($h -eq [IntPtr]::Zero) { Write-Host "screenshot-err:window-not-found"; exit 1 }

if ([WinShot]::IsIconic($h)) { [WinShot]::ShowWindow($h, 9) | Out-Null; Start-Sleep -Milliseconds 400 }
if ($Foreground) { [WinShot]::SetForegroundWindow($h) | Out-Null; Start-Sleep -Milliseconds 300 }

$r = New-Object WinShot+RECT
$dwm = [WinShot]::DwmGetWindowAttribute($h, 9, [ref]$r, [System.Runtime.InteropServices.Marshal]::SizeOf($r))
if ($dwm -ne 0) { [WinShot]::GetWindowRect($h, [ref]$r) | Out-Null }
$w = $r.Right - $r.Left; $ht = $r.Bottom - $r.Top
if ($w -le 0 -or $ht -le 0) { Write-Host "screenshot-err:bad-bounds"; exit 1 }

$capX = $r.Left; $capY = $r.Top; $capW = $w; $capH = $ht
if ($Crop -ne "") {
    $p = $Crop.Split(",")
    if ($p.Count -ne 4) { Write-Host "screenshot-err:bad-crop"; exit 1 }
    $cx = [double]$p[0]; $cy = [double]$p[1]; $cw = [double]$p[2]; $ch = [double]$p[3]
    if ($cx -le 1 -and $cy -le 1 -and $cw -le 1 -and $ch -le 1) {
        $cx = $cx * $w; $cy = $cy * $ht; $cw = $cw * $w; $ch = $ch * $ht
    }
    $cx = [int][Math]::Max(0, $cx); $cy = [int][Math]::Max(0, $cy)
    $cw = [int][Math]::Min($cw, $w - $cx); $ch = [int][Math]::Min($ch, $ht - $cy)
    if ($cw -le 0 -or $ch -le 0) { Write-Host "screenshot-err:bad-crop"; exit 1 }
    $capX = $r.Left + $cx; $capY = $r.Top + $cy; $capW = $cw; $capH = $ch
}

$bmp = New-Object System.Drawing.Bitmap($capW, $capH)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($capX, $capY, 0, 0, (New-Object System.Drawing.Size($capW, $capH)))
$bmp.Save($Dest)
$g.Dispose(); $bmp.Dispose()
Write-Host "screenshot-ok:$Dest title=$([WinShot]::LastTitle) size=$($capW)x$($capH)"
