# winrpc

Windows desktop automation RPC server. Exposes AHK v2 script execution, PowerShell, screenshot, and a cross-process UI lock over HTTP — so Mac/Linux CLI tools can drive a Windows desktop without each embedding their own server.

## Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Uptime check |
| `GET` | `/version` | Git commit + platform |
| `POST` | `/ahk-eval` | Execute AHK v2 script (body = script text; `?gui=1` for GUI mode) |
| `POST` | `/run-template` | Execute named AHK template (`{name, vars?, gui?, timeout?}`) |
| `POST` | `/shell` | Execute PowerShell inline (body = command text, 60s timeout) |
| `POST` | `/screenshot` | Take desktop screenshot, return PNG bytes |
| `GET` | `/lock` | Current cross-process UI lock state |
| `POST` | `/lock/force-unlock` | Admin: force-release the UI lock |
| `POST` | `/redeploy` | exit(2) so supervisor restarts with latest code |

## UI Lock

All `/ahk-eval` and `/run-template` requests are serialized via:
1. An in-process async queue (within this server process)
2. A cross-process file lock at `C:\tmp\im-ui.lock`

Multiple clients (wx-cli, qq-cli, …) share the same lock file so their AHK/PS UI operations never interleave.

## AHK Templates

Set `AHK_TEMPLATES_DIR` to point at your app's `ahk/` directory:

```
AHK_TEMPLATES_DIR=C:\path\to\wx-cli\ahk winrpc
```

Template files: `<dir>/<name>.template.ahk` or `<dir>/<name>.ahk`

Magic substitution vars (auto-included if present in the directory):
- `{{FIND_WECHAT}}` → `find-wechat.template.ahk`
- `{{FIND_WECHAT_READONLY}}` → `find-wechat-readonly.template.ahk`
- `{{FIND_WECHAT_PASSIVE}}` → `find-wechat-passive.template.ahk`
- `{{UIA_HELPERS}}` → `uia-helpers.template.ahk`

## Setup

**Prerequisites (Windows host):**
- [Bun](https://bun.sh) installed
- [AutoHotkey v2](https://www.autohotkey.com/) installed at `C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe` (or set `AHK_EXE` env)

```powershell
git clone https://github.com/snomiao/winrpc
cd winrpc/tree/main
bun install
bun src/index.ts
```

Default port: `12371`. Override with `PORT` env.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `12371` | HTTP listen port |
| `HOST` | `0.0.0.0` | HTTP listen host |
| `AHK_EXE` | `C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe` | AHK v2 executable path |
| `AHK_TEMPLATES_DIR` | `<cwd>/ahk` | Directory containing `.template.ahk` files |
| `IM_UI_LOCK_PATH` | `C:\tmp\im-ui.lock` | Cross-process lock file path |

## Used By

- [wx-cli](https://github.com/snomiao/wx-cli) — WeChat desktop automation CLI
