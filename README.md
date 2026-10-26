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
| `POST` | `/screenshot` | Screenshot → PNG bytes. Full screen, or a window via `?window=<title>` / `?process=<name>` (`&foreground=0` to skip focus). A window capture brings it to the front, so under a lease it is guarded (`screenshot-window`); a full-screen capture is not |
| `GET` | `/lock` | Current cross-process UI lock state, plus the active lease (owner, expiry; never its id) |
| `POST` | `/lock/acquire` | Take a UI lease `{owner, ttl_ms?, label?, wait_ms?}` → `{lease, expires_at}`, or `423` |
| `POST` | `/lock/renew` | Extend it `{lease, ttl_ms?}` (capped) → `{expires_at}`, or `410` |
| `POST` | `/lock/release` | End it `{lease}` → `{ok}`, or `410` |
| `POST` | `/lock/force-unlock` | Admin: force-release the UI lock (and any lease) |
| `POST` | `/redeploy` | exit(2) so supervisor restarts with latest code |

## CLI

| Command | Notes |
|---|---|
| `winrpc serve` (default) | Start the server |
| `winrpc ahk-repl [url] [--lease id]` | Pipe stdin lines to `/ahk-eval`; exits `75` if another owner holds a lease |
| `winrpc lock [--url …]` | `GET /lock`: lock state and lease |
| `winrpc lock acquire --owner <who> [--label …] [--ttl s] [--wait s]` | Prints `{lease, expires_at}`; exits `75` if held |
| `winrpc lock renew [lease] [--ttl s]` / `winrpc lock release [lease]` | lease from the argument or `$WINRPC_LEASE` |

- URL from the argument / `--url`, else `$WINRPC_URL`; token from the URL username, else `$WINRPC_TOKEN`
  (sent as `Authorization: Bearer`); lease from `--lease`, else `$WINRPC_LEASE` (sent as `X-Winrpc-Lease`).
- The token never prints: help, errors, banners and any other console output mask it
  (`http://***@host`, `abcd…`). The server banner names the file that holds it instead.

## UI Lock

All `/ahk-eval` and `/run-template` requests are serialized via:
1. An in-process async queue (within this server process)
2. A cross-process file lock at `C:\tmp\im-ui.lock`

Multiple clients (wx-cli, qq-cli, …) share the same lock file so their AHK/PS UI operations never interleave.

### Leases: hold the UI across steps

Each request takes the lock for itself only, so a flow such as screenshot → click → screenshot can be
interleaved by another client between its steps. A **lease** holds the lock for the whole flow:

```sh
lease=$(winrpc lock acquire --owner my-tool --label "upload file" --ttl 120 | jq -r .lease)
export WINRPC_LEASE=$lease
curl -X POST -H "X-Winrpc-Lease: $lease" … /screenshot; … /ahk-eval; … /screenshot
winrpc lock renew --ttl 120        # heartbeat for long flows
winrpc lock release
```

- While a lease is held, the holder's requests run without contending for the lock again; a guarded request
  from anyone else gets `423 {holder, label, expires_at}` (the CLI exits `75`), so it can wait or retry later.
- Guarded endpoints: `WINRPC_LEASE_GUARDS` (default `ahk-eval,run-template,shell,screenshot-window`). Full-screen `/screenshot` and
  read-only probes (`/ahk-eval?readonly=1`) are never guarded: they can't break the holder's flow.
- Bounded: each acquire/renew is capped at 10 min, and a lease lives at most 60 min in total. If the
  holder stops renewing, the lease is released when its TTL runs out. The lock file carries the same expiry,
  so other processes take over even if the server itself dies. `force-unlock` ends a lease too.
- While an action runs (holder or per-request), a heartbeat keeps the lock file at least 60 s ahead, renewed every
  15 s. A renew only writes while the file is still ours; a lost lock ends the lease (renew → `410`).
- Known limit: the lock is a plain file without compare-and-swap. The ownership check and the write (and an
  expired-lock takeover by another process) are separate steps, so a holder stalled for more than ~45 s around
  its expiry could still race a takeover. The heartbeat keeps a live action far from expiry.

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
- `{{FIND_OWNED}}` → `FindOwnedWindow(ownerHwnd, ownerExe, cls, titleSub)` (winrpc's `ahk/lib-find-owned.ahk`)
- `{{IME_OFF}}` → `ImeOff(hwnd)` (winrpc's `ahk/lib-ime-off.ahk`)

Vars a caller does not pass render empty (the templates give them defaults).

winrpc's own templates (in `ahk/`, found even when `AHK_TEMPLATES_DIR` points elsewhere; an app's file of
the same name wins):

| Template | Vars | What it does |
|---|---|---|
| `find-owned-window` | `OWNER_HWND`, `OWNER_EXE`, `CLASS`, `TITLE`, `WAIT_MS` | Finds a dialog by its **owner window**, e.g. Chrome's file picker (`OWNER_EXE=chrome.exe`, `CLASS=#32770`). Prints `hwnd, class, pid, owner hwnd, owner exe`; exit 3 if none |
| `paste-text` | `TEXT_B64`, `TARGET`, `CONTROL`, `SETTLE_MS`, `VERIFY` | Activates the window, focuses the control, turns the IME off, pastes the text through the clipboard and restores the clipboard. `VERIFY=1` reads the control back (exit 6 if the text isn't there) |
| `ime-off` | `TARGET` | Sets the IME of the focused control to direct input (Japanese Windows starts many fields with it on). Run before any typed keys |

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
