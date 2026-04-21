# serve-loop.ps1 - Supervise the winrpc Windows-automation RPC server.
#
# Runs from a standalone checkout at C:\tmp\winrpc (or wherever WINRPC_DIR
# points). Self-updating: clones on first boot, pulls on every restart, and
# polls origin/main every 15s to restart on upstream change.
#
# Registered as schtask "WinrpcServeLoop" by install-schtask.ps1, with
# "Run only when user is logged on" + "Run with highest privileges" so
# AHK/UIA calls have desktop access.
#
# IMPORTANT: ASCII-only file. PowerShell on Chinese Windows reads scripts
# with the system code page (cp936) and mis-decodes multi-byte UTF-8, which
# produces literal quote characters that break string termination.

$winrpcDir  = if ($env:WINRPC_DIR)     { $env:WINRPC_DIR }     else { "C:\tmp\winrpc" }
$winrpcRepo = if ($env:WINRPC_GIT_URL) { $env:WINRPC_GIT_URL } else { "https://github.com/snomiao/winrpc" }
$bun        = if ($env:WIN_BUN_EXE)    { $env:WIN_BUN_EXE }    else { "$env:USERPROFILE\.bun\bin\bun.exe" }
$port       = if ($env:WINRPC_PORT)    { $env:WINRPC_PORT }    else { "12376" }
$logFile    = "C:\tmp\winrpc-serve-loop.log"
$pollInterval = 15

function Log($msg) {
    $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$ts $msg" | Tee-Object -FilePath $logFile -Append
}

if (-not (Test-Path $winrpcDir)) {
    Log "Cloning $winrpcRepo -> $winrpcDir"
    git clone $winrpcRepo $winrpcDir 2>&1 | Tee-Object -FilePath $logFile -Append
}

Set-Location $winrpcDir

while ($true) {
    git fetch origin 2>&1 | Out-Null
    git checkout -- . 2>&1 | Out-Null
    git reset --hard origin/main 2>&1 | Out-Null
    if (-not (Test-Path "node_modules")) {
        Log "Installing winrpc dependencies"
        & $bun install 2>&1 | Tee-Object -FilePath $logFile -Append
    }
    $startRev = (git rev-parse HEAD).Trim()
    Log "Starting winrpc rev=$($startRev.Substring(0,8)) port=$port AHK_TEMPLATES_DIR=$($env:AHK_TEMPLATES_DIR)"

    # Per-run log files: Start-Process -RedirectStandardOutput truncates on
    # open, so reusing one path wipes the previous run's crash output. Use
    # unique names and prune old ones so the next supervisor iteration can
    # diagnose crashes instead of losing them.
    $runStamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $outLog = "C:\tmp\winrpc-serve-$runStamp.log"
    $errLog = "C:\tmp\winrpc-serve-$runStamp.err.log"
    $env:PORT = $port
    $p = Start-Process -FilePath $bun `
        -ArgumentList "src/index.ts" `
        -WorkingDirectory $winrpcDir -PassThru -NoNewWindow `
        -RedirectStandardOutput $outLog `
        -RedirectStandardError  $errLog
    Log "winrpc PID: $($p.Id) out=$outLog err=$errLog"
    # Keep only the 10 most-recent per-run logs.
    Get-ChildItem "C:\tmp\winrpc-serve-*.log" -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -Skip 20 |
        Remove-Item -Force -ErrorAction SilentlyContinue

    $upstreamChanged = $false
    while (!$p.HasExited) {
        Start-Sleep $pollInterval
        try {
            $lsRemoteLine = (git ls-remote origin refs/heads/main 2>$null) -split "`t" | Select-Object -First 1
            $remoteRev = $lsRemoteLine.Trim()
        } catch { $remoteRev = $startRev }
        if ($remoteRev -and $remoteRev -ne $startRev) {
            Log "winrpc upstream commit: $($startRev.Substring(0,8)) -> $($remoteRev.Substring(0,8)), restarting"
            $upstreamChanged = $true
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
            break
        }
    }

    try { $p.WaitForExit() } catch {}
    $exitCode = $p.ExitCode
    Log "winrpc exited (code=$exitCode, upstreamChanged=$upstreamChanged), restarting in 2s"
    # Inline the last 20 lines of stderr/stdout into the supervisor log so
    # crashes are visible without hunting for the per-run file.
    if (Test-Path $errLog) {
        $tail = Get-Content $errLog -Tail 20 -ErrorAction SilentlyContinue
        if ($tail) { Log "--- stderr tail ---"; $tail | ForEach-Object { Log "  $_" } }
    }
    if ((-not $exitCode -or $exitCode -ne 0) -and (Test-Path $outLog)) {
        $tail = Get-Content $outLog -Tail 10 -ErrorAction SilentlyContinue
        if ($tail) { Log "--- stdout tail ---"; $tail | ForEach-Object { Log "  $_" } }
    }
    Start-Sleep 2
}
