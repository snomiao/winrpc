; ImeOff(hwnd) -> sets the IME of hwnd's focused control (or of hwnd, or of the active window) to
; direct input (IME closed). Returns the previous open status (1 = was on, 0 = was off, -1 = no IME).
; Japanese Windows starts many fields with the IME on, so typed or pasted ASCII is converted or its first
; characters are swallowed. Call this before any Send of text.
ImeOff(hwnd := 0) {
  if !hwnd
    hwnd := WinExist("A")
  target := hwnd
  try {
    ctl := ControlGetFocus("ahk_id " hwnd)
    if ctl
      target := ctl
  }
  ime := DllCall("imm32\ImmGetDefaultIMEWnd", "Ptr", target, "Ptr")
  if !ime
    return -1
  prevHidden := DetectHiddenWindows(true)  ; the IME window is hidden
  try {
    prev := SendMessage(0x283, 0x5, 0, , "ahk_id " ime)  ; WM_IME_CONTROL, IMC_GETOPENSTATUS
    SendMessage(0x283, 0x6, 0, , "ahk_id " ime)          ; IMC_SETOPENSTATUS, 0 = closed
  } finally {
    DetectHiddenWindows(prevHidden)
  }
  return prev
}
