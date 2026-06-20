# Capture the full primary screen (or a sub-region) to $Dest as PNG.
#
# -Crop "x,y,w,h" restricts capture to a rectangle. Values <= 1 are treated as
# fractions of the screen size; otherwise they are pixels. Origin = top-left.
param(
    [Parameter(Mandatory = $true)][string]$Dest,
    [string]$Crop = "",
    [int]$MaxWidth = 0
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
if ($MaxWidth -gt 0 -and $bmp.Width -gt $MaxWidth) {
    $nw = $MaxWidth; $nh = [int]($bmp.Height * $MaxWidth / $bmp.Width)
    $scaled = New-Object System.Drawing.Bitmap($nw, $nh)
    $sg = [System.Drawing.Graphics]::FromImage($scaled)
    $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $sg.DrawImage($bmp, 0, 0, $nw, $nh)
    $sg.Dispose(); $g.Dispose(); $bmp.Dispose(); $bmp = $scaled
} else { $g.Dispose() }
$fw = $bmp.Width; $fh = $bmp.Height
$bmp.Save($Dest)
$bmp.Dispose()
Write-Host "screenshot-ok:$Dest size=$($fw)x$($fh)"
