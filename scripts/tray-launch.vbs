' tray-launch.vbs — start the winrpc tray with NO console window.
'
' The tray is a long-lived foreground-session process; launching bun directly
' (from Task Scheduler, a shortcut, or shell:startup) flashes a console window
' and leaves one on the taskbar. Style 0 + bWaitOnReturn=False detaches it.
'
' Usage:  wscript scripts\tray-launch.vbs
' Autostart:  drop a shortcut to this file in shell:startup
Dim sh, fso, repoDir, bun
Set sh  = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' scripts\ -> repo root
repoDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
bun = sh.ExpandEnvironmentStrings("%USERPROFILE%\.bun\bin\bun.exe")
If Not fso.FileExists(bun) Then bun = "bun.exe"

sh.CurrentDirectory = repoDir
sh.Run """" & bun & """ src/tray.ts", 0, False
