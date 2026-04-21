# install-schtask.ps1 - Register WinrpcServeLoop schtask
#
# Creates a scheduled task that:
#   - Runs at user logon
#   - Runs ONLY when the user is logged on (needs interactive session for UIA)
#   - Runs with highest privileges (required for some WeChat UI interactions)
#   - Executes scripts\serve-loop.ps1 hidden
#
# Usage (elevated PowerShell):
#   powershell -ExecutionPolicy Bypass -File scripts\install-schtask.ps1
#
# Uninstall:
#   schtasks /delete /tn WinrpcServeLoop /f

param(
    [string]$TaskName  = "WinrpcServeLoop",
    [string]$ScriptDir = $PSScriptRoot
)

$loopScript = Join-Path $ScriptDir "serve-loop.ps1"
if (-not (Test-Path $loopScript)) {
    throw "serve-loop.ps1 not found at $loopScript"
}

# Workgroup hosts report USERDOMAIN=WORKGROUP, which is not a resolvable
# security principal. Fall back to COMPUTERNAME for non-domain-joined hosts.
$domain = if ($env:USERDOMAIN -and $env:USERDOMAIN -ne "WORKGROUP") { $env:USERDOMAIN } else { $env:COMPUTERNAME }
$userId = "$domain\$env:USERNAME"

$action    = New-ScheduledTaskAction -Execute "powershell.exe" `
                -Argument "-WindowStyle Hidden -ExecutionPolicy Bypass -File `"$loopScript`""
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $userId
$principal = New-ScheduledTaskPrincipal -UserId $userId `
                -LogonType Interactive -RunLevel Highest
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
                -DontStopIfGoingOnBatteries -StartWhenAvailable `
                -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Principal $principal -Settings $settings -Force | Out-Null

Write-Output "Registered schtask: $TaskName"
Write-Output "  loop script: $loopScript"
Write-Output "  logs:        C:\tmp\winrpc-serve-loop.log, C:\tmp\winrpc-serve.log"
Write-Output ""
Write-Output "To start now:   schtasks /run /tn $TaskName"
Write-Output "To stop:        schtasks /end /tn $TaskName"
Write-Output "To remove:      schtasks /delete /tn $TaskName /f"
