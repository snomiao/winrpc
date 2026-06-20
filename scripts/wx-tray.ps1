# winrpc/wx-server system-tray daemon. No console; tray icon + right-click menu
# (copy connection token), and keeps both bun services alive.
$ErrorActionPreference = "SilentlyContinue"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$bun = "C:\bun\bin\bun.exe"
$services = @(
  @{ Name="winrpc";    Dir="C:\tmp\winrpc"; Args="src/index.ts";                          Env=@{PORT="12374"}; Proc=$null },
  @{ Name="wx-server"; Dir="C:\tmp\wx-cli"; Args="wx.ts serve --host 0.0.0.0 --port 12370"; Env=@{};            Proc=$null }
)
function Start-Svc($s) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $bun; $psi.Arguments = $s.Args; $psi.WorkingDirectory = $s.Dir
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  foreach($k in $s.Env.Keys){ $psi.EnvironmentVariables[$k] = $s.Env[$k] }
  $s.Proc = [System.Diagnostics.Process]::Start($psi)
}
foreach($s in $services){ Start-Svc $s }
function Get-WinrpcUrl { $f="C:\tmp\winrpc\.winrpc.token"; if(Test-Path $f){ "http://"+((Get-Content $f -Raw).Trim())+"@localhost:12374" } else { "(not ready)" } }
function Get-WxUrl { $m=(Select-String -Path "C:\tmp\wx-cli\.env.local" -Pattern 'WX_CLI_URL=(\S+)').Matches; if($m){ $m.Groups[1].Value } else { "(not ready)" } }
$ni = New-Object System.Windows.Forms.NotifyIcon
$ni.Icon = [System.Drawing.SystemIcons]::Application
$ni.Text = "winrpc :12374 / wx-server :12370"
$ni.Visible = $true
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$a = $menu.Items.Add("Copy winrpc token (WINRPC_URL)")
$a.add_Click({ Set-Clipboard (Get-WinrpcUrl); $ni.ShowBalloonTip(1500,"winrpc","WINRPC_URL copied",[System.Windows.Forms.ToolTipIcon]::Info) })
$b = $menu.Items.Add("Copy wx-server URL (WX_CLI_URL)")
$b.add_Click({ Set-Clipboard (Get-WxUrl); $ni.ShowBalloonTip(1500,"wx-server","WX_CLI_URL copied",[System.Windows.Forms.ToolTipIcon]::Info) })
$menu.Items.Add("-") | Out-Null
$c = $menu.Items.Add("Restart services")
$c.add_Click({ foreach($s in $services){ if($s.Proc -and -not $s.Proc.HasExited){ $s.Proc.Kill() }; Start-Sleep -m 400; Start-Svc $s }; $ni.ShowBalloonTip(1500,"wx","Restarted",[System.Windows.Forms.ToolTipIcon]::Info) })
$d = $menu.Items.Add("Quit")
$d.add_Click({ foreach($s in $services){ if($s.Proc -and -not $s.Proc.HasExited){ $s.Proc.Kill() } }; $ni.Visible=$false; [System.Windows.Forms.Application]::Exit() })
$ni.ContextMenuStrip = $menu
$ni.add_MouseDoubleClick({ Set-Clipboard (Get-WinrpcUrl); $ni.ShowBalloonTip(1500,"winrpc","WINRPC_URL copied",[System.Windows.Forms.ToolTipIcon]::Info) })
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.add_Tick({ foreach($s in $services){ if($s.Proc.HasExited){ Start-Svc $s } } })
$timer.Start()
[System.Windows.Forms.Application]::Run()
