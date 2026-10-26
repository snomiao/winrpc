; FindOwnedWindow(ownerHwnd, ownerExe, cls, titleSub) -> hwnd of the topmost visible window OWNED by
; another window, or 0.
; A dialog such as Chrome's file picker belongs to a different window than the main one (and on some
; apps to a different process), so a guard on the main window's title/PID does not find it. Its owner
; (GetWindow GW_OWNER) does.
;   ownerHwnd: owner window handle (0 = any owner)
;   ownerExe:  owner's process name, e.g. "chrome.exe" ("" = any)
;   cls:       dialog class, e.g. "#32770" for the common file dialogs ("" = any)
;   titleSub:  part of the dialog title ("" = any)
FindOwnedWindow(ownerHwnd := 0, ownerExe := "", cls := "", titleSub := "") {
  for hwnd in WinGetList() {  ; visible windows, topmost first
    owner := DllCall("GetWindow", "Ptr", hwnd, "UInt", 4, "Ptr")  ; GW_OWNER
    if !owner
      continue
    if ownerHwnd && owner != ownerHwnd
      continue
    try {
      if ownerExe != "" && StrLower(WinGetProcessName("ahk_id " owner)) != StrLower(ownerExe)
        continue
      if cls != "" && WinGetClass("ahk_id " hwnd) != cls
        continue
      if titleSub != "" && !InStr(WinGetTitle("ahk_id " hwnd), titleSub)
        continue
    } catch {
      continue  ; the window closed while we looked
    }
    return hwnd
  }
  return 0
}
