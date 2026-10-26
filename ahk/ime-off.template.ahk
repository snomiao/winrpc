#Requires AutoHotkey v2.0
; Set the IME of a window's focused control to direct input (see lib-ime-off.ahk).
; vars: TARGET (WinTitle, e.g. "ahk_id 0x1A2B"; default the active window)
; stdout: "ime was on" / "ime was off" / "no ime"
{{IME_OFF}}
target := "{{TARGET}}"
win := target = "" ? WinExist("A") : WinExist(target)
if !win {
  _PrintErr("target window not found")
  ExitApp 3
}
prev := ImeOff(win)
_Print(prev = -1 ? "no ime" : prev ? "ime was on" : "ime was off")
