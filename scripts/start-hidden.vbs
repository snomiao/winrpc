' start-hidden.vbs <workdir> <commandline>
' Runs a console process with NO window (style 0) and waits for it to exit.
' Used by the daemon supervisor so bun has no visible console.
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = WScript.Arguments(0)
sh.Run WScript.Arguments(1), 0, True
