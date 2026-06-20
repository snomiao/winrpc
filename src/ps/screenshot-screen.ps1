# Capture the full primary screen (or a sub-region) to $Dest as PNG.
#
# -Crop "x,y,w,h" restricts capture to a rectangle. Values <= 1 are treated as
# fractions of the screen size; otherwise they are pixels. Origin = top-left.
param(
    [Parameter(Mandatory = $true)][string]$Dest,
    [string]$Crop = ""
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$capX = $bounds.X; $capY = $bounds.Y; $capW = $bounds.Width; $capH = $bounds.Height

if ($Crop -ne "") {
    $p = $Crop.Split(",")
    if ($p.Count -ne 4) { Write-Host "screenshot-err:bad-crop"; exit 1 }
    $cx = [double]$p[0]; $cy = [double]$p[1]; $cw = [double]$p[2]; $ch = [double]$p[3]
    if ($cx -le 1 -and $cy -le 1 -and $cw -le 1 -and $ch -le 1) {
        $cx = $cx * $bounds.Width; $cy = $cy * $bounds.Height
        $cw = $cw * $bounds.Width; $ch = $ch * $bounds.Height
    }
    $cx = [int][Math]::Max(0, $cx); $cy = [int][Math]::Max(0, $cy)
    $cw = [int][Math]::Min($cw, $bounds.Width - $cx); $ch = [int][Math]::Min($ch, $bounds.Height - $cy)
    if ($cw -le 0 -or $ch -le 0) { Write-Host "screenshot-err:bad-crop"; exit 1 }
    $capX = $bounds.X + $cx; $capY = $bounds.Y + $cy; $capW = $cw; $capH = $ch
}

$bmp = New-Object System.Drawing.Bitmap($capW, $capH)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($capX, $capY, 0, 0, (New-Object System.Drawing.Size($capW, $capH)))
$bmp.Save($Dest)
$g.Dispose(); $bmp.Dispose()
Write-Host "screenshot-ok:$Dest size=$($capW)x$($capH)"
