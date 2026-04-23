# winrpc — Specification

Windows desktop automation RPC server. Runs on a Windows host and exposes HTTP
endpoints for AutoHotkey v2 scripting, PowerShell execution, screenshot capture,
OCR, and a cross-process UI mutex. Clients (usually remote machines or local
agents) call it over HTTP with a bearer/basic token.

Runtime: [Bun](https://bun.sh). HTTP framework: [Elysia](https://elysiajs.com).
CLI: [yargs](https://yargs.js.org).

---

## 1. Configuration

Environment variables (Bun auto-loads `./.env.local` and `./.env`):

| Variable | Default | Purpose |
|---|---|---|
| `WINRPC_TOKEN` | _auto-generated on first run_ | Server's access token. Clients must present this. |
| `WINRPC_URL` | _(unset)_ | Client-side URL, form `http://<token>@host:port`. Consumed by CLI subcommands and library helpers. |
| `HOST` | `0.0.0.0` | Listen host. |
| `PORT` | `12371` | Listen port. |
| `AHK_EXE` | `C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe` | AutoHotkey v2 binary path. |
| `AHK_TEMPLATES_DIR` | `<cwd>/ahk` | Directory of `*.template.ahk` / `*.ahk` templates. |
| `IM_UI_LOCK_PATH` | `$TMPDIR/im-ui.lock` | Cross-process UI lock file. |

### First-run token

On startup, `src/auth.ts` reads `WINRPC_TOKEN`. If missing, it generates a 32-byte
hex token and appends `WINRPC_TOKEN=<hex>` to `./.env.local` (creating the file
with `0600` permissions if needed). The startup banner prints a
`WINRPC_URL=http://<token>@host:port` line to paste into the client's
`.env.local`.

### Authentication

All routes **except** `GET /health` require one of:

- `Authorization: Bearer <token>`
- `Authorization: Basic <base64(token:)>` — token as username, empty password;
  matches browser-style `http://<token>@host:port` URLs.

Invalid/missing token → `401 Unauthorized` with
`WWW-Authenticate: Basic realm="winrpc"`.

---

## 2. HTTP API

Base URL: `http://<host>:<port>`.

### `GET /health`

Unauthenticated. Returns `{ ok: true, uptime, pid }`.

### `GET /version`

Returns package version.

### `GET /lock` / `POST /lock/force-unlock`

Inspect / forcibly release the UI mutex (see §3).

### `POST /ahk-eval`

Execute an AutoHotkey v2 script.

- Body: raw script text (`text/plain`).
- Query: `gui=1` to run visibly, `readonly=1` to bypass the UI lock (for
  passive probes).
- Returns `{ ok, stdout, stderr, exitCode }`.
- Serialized through the UI lock unless `readonly=1`.

### `POST /run-template`

Run a named template from `AHK_TEMPLATES_DIR`.

- Body: `{ name: string, vars?: Record<string,string>, gui?: boolean, timeout?: number }`.
- Template resolution: `<name>.template.ahk` → `<name>.ahk`. `{{VAR}}`
  placeholders (and a set of built-in include markers like `{{UIA_HELPERS}}`)
  are substituted before execution.
- Returns `{ ok, stdout, stderr, exitCode }`.
- Always serialized through the UI lock.

### `POST /shell`

Run a PowerShell one-liner. Body: command text. Timeout: 60 s.
Returns `{ ok, stdout, stderr, exitCode }`.

### `POST /screenshot`

Capture a full-desktop PNG. Returns `image/png` bytes with
`X-Screenshot-Path` header pointing at the on-disk temp file.

### `POST /ocr`

Run OCR on an image.

- Body: raw image bytes, **or** JSON `{ "path": "C:\\..." }`.
- Query: `lang` (default `ch`).
- Returns OCR result JSON.

### `POST /redeploy`

Exits the process after 200 ms so the supervisor (see `scripts/`) can
pull and restart.

---

## 3. UI mutex

Windows UI automation is not reentrant-safe across processes. `src/ui-lock.ts`
implements a file-based mutex at `$IM_UI_LOCK_PATH`. All `/ahk-eval` (unless
`readonly=1`) and `/run-template` requests go through `withUiQueue`, which:

1. Acquires the lock.
2. Runs the callback inside an `AsyncLocalStorage` context so nested calls are
   reentrant within a single request.
3. Releases the lock.

`GET /lock` reports the current holder; `POST /lock/force-unlock` clears a
stuck lock.

---

## 4. AHK integration (`src/ahk.ts`)

- `ahkEscape(s, {multiline?})` — escape a JS string for AHK v2.
- `ahkTemplate(name, vars)` — load `<name>.template.ahk`, substitute `{{VAR}}`
  placeholders + built-in include markers, return the final script.
- `runAhk(script, {gui?, timeout?})` — write to a temp `.ahk` file under
  `C:\tmp\`, spawn `AHK_EXE`, collect stdout/stderr/exitCode.
- Every script is prefixed with an `OnError` handler that routes runtime
  errors to stderr (see commit `4cbd1a6`).

Template directory layout:

```
ahk/
  find-wechat.template.ahk
  find-wechat-readonly.template.ahk
  uia-helpers.template.ahk
  ...
```

---

## 5. CLI

Entry point: `./src/index.ts` (registered as the `winrpc` bin).

```
winrpc [command]

Commands:
  winrpc serve           Start the winrpc server                       [default]
  winrpc ahk-repl [url]  Pipe stdin lines to a target winrpc server as AHK
                         commands, print responses inline
```

### `winrpc serve` (default)

Flags: `--host` (env `HOST`, default `0.0.0.0`), `--port` (env `PORT`,
default `12371`).

Starts the Elysia server, prints the access token banner.

### `winrpc ahk-repl [url]`

Positional `url` defaults to `$WINRPC_URL`. Format: `http://<token>@host:port`
(token becomes `Authorization: Bearer <token>`).

Reads stdin one line at a time. Each non-empty line is POSTed as-is to
`/ahk-eval` on the target server. The JSON response is unpacked inline:
`stdout` → stdout, `stderr` → stderr, non-OK with empty stderr → `[exit N]`.

TTY mode shows an `ahk> ` prompt and a startup banner; pipe/redirect mode is
silent. Exits on EOF (Ctrl-D).

Example:

```sh
echo 'MsgBox "hi"' | winrpc ahk-repl http://deadbeef@win-host:12371
# or interactive:
WINRPC_URL=http://deadbeef@win-host:12371 winrpc ahk-repl
ahk> WinGetTitle("A")
Untitled - Notepad
ahk>
```

Note: each line is one independent AHK script execution — there is no
persistent process state between lines.

---

## 6. File layout

```
src/
  index.ts        — CLI entry (yargs: serve, ahk-repl)
  server.ts       — Elysia routes + UI-lock wiring
  auth.ts         — token load/generate, Basic/Bearer check
  ahk.ts          — AutoHotkey escaping, templates, runner
  powershell.ts   — PowerShell runner
  screenshot.ts   — screen capture
  ocr.ts          — OCR pipeline
  ui-lock.ts      — cross-process UI mutex
ahk/              — AutoHotkey templates
scripts/          — supervisor / scheduled-task helpers
```

### Ignored / generated

- `.env.local` — contains `WINRPC_TOKEN` (gitignored, `0600`).
- `tmp/`, `C:/tmp/` — AHK script scratch + screenshot/OCR inputs.
- `node_modules/`, `bun.lockb`, `*.lock`.

---

## 7. Supervisor

`scripts/` hosts the Windows supervisor (Scheduled Task + loop runner) that
keeps `winrpc serve` alive and collects per-run logs. `POST /redeploy` exits
the process so the supervisor restarts it (typically after a `git pull`).
See recent commits `4190fa0`, `16622e9`, `f2c0680` for the current shape.
