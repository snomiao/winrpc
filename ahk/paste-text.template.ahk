#Requires AutoHotkey v2.0
; Paste text into a control through the clipboard, with the IME off; the clipboard is restored after.
; Typed input (Send) lost its first characters on Japanese Windows (focus/IME races); a paste is one event.
; vars:
;   TEXT_B64  the text, UTF-8, base64 (so quotes, backticks and newlines need no escaping)
;   TARGET    WinTitle of the window, e.g. "ahk_id 0x1A2B" (default the active window)
;   CONTROL   ClassNN of the control to focus, e.g. "Edit1" (default whatever has focus)
;   SETTLE_MS wait after focusing, default 150
;   VERIFY    "1" = read the control's text back and exit 6 if it does not contain the text
; stdout: "pasted <n> chars" (+ "verified"); exit 3 window not found, 4 not activated, 5 clipboard busy.
{{IME_OFF}}
B64Decode(b64) {
  if b64 = ""
    return ""
  size := 0
  DllCall("crypt32\CryptStringToBinary", "Str", b64, "UInt", 0, "UInt", 1, "Ptr", 0, "UInt*", &size, "Ptr", 0, "Ptr", 0)
  buf := Buffer(size)
  DllCall("crypt32\CryptStringToBinary", "Str", b64, "UInt", 0, "UInt", 1, "Ptr", buf, "UInt*", &size, "Ptr", 0, "Ptr", 0)
  return StrGet(buf, size, "UTF-8")
}
text := B64Decode("{{TEXT_B64}}")
target := "{{TARGET}}"
control := "{{CONTROL}}"
settleArg := "{{SETTLE_MS}}"
settle := settleArg = "" ? 150 : Integer(settleArg)

win := target = "" ? WinExist("A") : WinExist(target)
if !win {
  _PrintErr("target window not found")
  ExitApp 3
}
WinActivate "ahk_id " win
if !WinWaitActive("ahk_id " win, , 2) {
  _PrintErr("target window did not become active")
  ExitApp 4
}
if control != ""
  ControlFocus control, "ahk_id " win
Sleep settle
ImeOff(win)

saved := ClipboardAll()
A_Clipboard := ""
A_Clipboard := text
if !ClipWait(2) {
  A_Clipboard := saved
  _PrintErr("clipboard did not take the text")
  ExitApp 5
}
Send "^v"
Sleep 300
A_Clipboard := saved
saved := ""
_Print("pasted " StrLen(text) " chars")

if "{{VERIFY}}" = "1" {
  got := ""
  try got := ControlGetText(control != "" ? control : ControlGetFocus("ahk_id " win), "ahk_id " win)
  if !InStr(got, text) {
    _PrintErr("the control does not show the pasted text")
    ExitApp 6
  }
  _Print("`nverified")
}
