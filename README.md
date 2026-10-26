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
| `POST` | `/screenshot` | Screenshot → PNG bytes. Full screen, or a window via `?window=<title>` / `?process=<name>` (`&foreground=0` to skip focus) |
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
# Convention: clone to C:\Users\<user>\ws\winrpc\
git clone https://github.com/snomiao/winrpc C:\Users\$env:USERNAME\ws\winrpc
cd C:\Users\$env:USERNAME\ws\winrpc\tree\main
bun install
bun src/index.ts
```

Default port: `12371`. Override with `PORT` env.

## System Tray

`winrpc tray` (or `bun src/tray.ts`) puts a tray icon on the Windows notification
area for the server running on this host. The icon is blue while `GET /health`
answers and red when it does not; the menu is rebuilt from `/health` + `/lock`
every 5s.

Menu:
- **status line** — uptime and PID from `/health`
- **Copy WINRPC_URL** — puts `http://<token>@localhost:<port>` on the clipboard
- **Open .../health** — opens it in the default browser
- **UI lock** line, plus **Force-unlock UI lock** (enabled only while a lock is held)
- **Restart server** — `POST /redeploy`; the server exits(2) and its supervisor
  relaunches it on the latest code
- **Quit Tray** — closes the icon only; the server keeps running

The tray is a client: it never starts or supervises the server (that is the
scheduled task, see `register-winrpc.ps1` / `scripts/install-schtask.ps1`), so it
can be started and quit freely. It reads `WINRPC_TOKEN` from the environment or
`.env.local` and never generates one — a tray started before the server can't
mint a token the server won't have.

Run it window-less (no console flash), e.g. from a shortcut in `shell:startup`:

```
wscript scripts\tray-launch.vbs
```

Set `PORT` (or `winrpc tray --port`) when the server is not on `12371`.

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
