import { mkdirSync } from "fs";
import { runPowerShell } from "./powershell";

export async function takeScreenshot(outPath?: string): Promise<string> {
  const tmpDir = process.platform === "win32" ? "C:\\tmp" : "/tmp";
  mkdirSync(tmpDir, { recursive: true });
  const dest = outPath ?? `${tmpDir}\\screenshot-${Date.now()}.png`;
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save('${dest.replace(/\\/g, "\\\\")}')
$g.Dispose(); $bmp.Dispose()
Write-Host "screenshot-ok:${dest.replace(/\\/g, "\\\\")}"
`.trim();
  const r = await runPowerShell(ps, { timeout: 15_000 });
  if (!r.ok || !r.stdout.includes("screenshot-ok")) throw new Error(`Screenshot failed: ${r.stderr}`);
  return dest;
}
