# Capture the full primary screen to $Dest as PNG.
param(
    [Parameter(Mandatory = $true)][string]$Dest
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save($Dest)
$g.Dispose(); $bmp.Dispose()
Write-Host "screenshot-ok:$Dest"
