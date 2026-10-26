#Requires AutoHotkey v2.0
; Find a dialog by its owner window (see lib-find-owned.ahk).
; vars (all optional): OWNER_HWND (e.g. 0x1A2B), OWNER_EXE (e.g. chrome.exe), CLASS (e.g. #32770),
;   TITLE (part of the title), WAIT_MS (wait for it to appear, default 0)
; stdout: "<hwnd>\t<class>\t<pid>\t<owner hwnd>\t<owner exe>"; exit 3 when none is found.
{{FIND_OWNED}}
ownerArg := "{{OWNER_HWND}}"
ownerHwnd := ownerArg = "" ? 0 : Integer(ownerArg)
waitArg := "{{WAIT_MS}}"
deadline := A_TickCount + (waitArg = "" ? 0 : Integer(waitArg))
loop {
  hwnd := FindOwnedWindow(ownerHwnd, "{{OWNER_EXE}}", "{{CLASS}}", "{{TITLE}}")
  if hwnd || A_TickCount >= deadline
    break
  Sleep 100
}
if !hwnd {
  _PrintErr("no owned window matched")
  ExitApp 3
}
owner := DllCall("GetWindow", "Ptr", hwnd, "UInt", 4, "Ptr")
_Print(Format("0x{:X}`t{}`t{}`t0x{:X}`t{}", hwnd, WinGetClass("ahk_id " hwnd), WinGetPID("ahk_id " hwnd), owner, WinGetProcessName("ahk_id " owner)))
