# Cross-platform supervisor / service controller — options & decision

Research note: is there a TS library that installs a supervised long-running
process as a **Windows Scheduled Task** *and* a **Linux systemd unit** (and
ideally macOS launchd) behind one API? Captured for winrpc's `scripts/`
supervisor and any future cross-platform port.

## TL;DR

- **No clean, maintained, TS-native lib does `schtask` + `systemd` the way we
  want.** The closest (`@munogu/service`) is abandoned and uses `nssm` (a
  Windows *service*), not schtask.
- **More importantly, the generic libs are the wrong abstraction for winrpc.**
  They all install a **Session-0 Windows service**, which has **no desktop
  access** and therefore **cannot drive the GUI** (AHK/UIA). winrpc deliberately
  uses a **Scheduled Task with "run only when user is logged on" + interactive +
  highest privileges** so its automation can reach the desktop. See
  `scripts/install-schtask.ps1`.
- **Recommendation:** build a small in-repo TS supervisor-controller rather than
  adopt a lib — the hard half (the interactive schtask) already exists.

## Current state (winrpc)

Windows-only:
- `scripts/install-schtask.ps1` — registers schtask `WinrpcServeLoop`, **AtLogOn**,
  `LogonType Interactive`, `RunLevel Highest`, restart 3× @ 1 min.
- `scripts/serve-loop.ps1` — self-updating supervisor loop: clone-on-first-boot,
  `git reset --hard origin/main`, `bun install` if needed, poll origin every 15s,
  restart on upstream change.

No cross-platform layer; nothing in TS.

## Ecosystem options

| Lib | Win backend | Linux | macOS | TS? | State | Notes |
|---|---|---|---|---|---|---|
| [@munogu/service](https://github.com/munogu/node-service) | nssm.exe | systemd | launchd | ✗ | ~abandoned (4 commits, 0★) | The exact abstraction we'd want, but needs `nssm` binary + admin; JS only |
| [node-windows](https://github.com/coreybutler/node-windows) / [node-linux](https://github.com/coreybutler/node-linux) / [node-mac](https://github.com/coreybutler/node-mac) | winsw | systemd | launchd | ✗ | mature but dated | 3 separate packages; [never merged](https://github.com/coreybutler/node-linux/issues/10); "shim on a shim" arch |
| [os-service](https://github.com/NeuraLegion/node-os-service) | SCM (native addon) | systemd | ✗ | ✗ | low-level | no macOS; C++ addon |
| [service-systemd](https://www.npmjs.com/package/service-systemd) | — | systemd | — | ✗ | abandoned (7yr) | Linux only |
| pm2 (`pm2 startup` + `pm2-installer` / `pm2-windows-service`) | service | systemd/launchd/SysV | ✓ | partial | battle-tested | Heavy; manages a daemon, not native schtask |

## The disqualifying constraint: GUI access

winrpc exists to drive the desktop (AHK v2 / UIA). That requires an **interactive
desktop session**:

- **Windows:** Session-0 services (winsw / nssm / SCM — what every lib above
  installs) run in an isolated session with **no visible desktop**, so they
  cannot send input to or read GUI apps. The working approach is a **Scheduled
  Task** with *run only when the user is logged on* + interactive + highest
  privileges (already implemented in `install-schtask.ps1`).
- **Linux:** a future port must run inside a graphical session — a
  **`systemctl --user`** unit (or a system unit with correct `DISPLAY` /
  `XAUTHORITY`), not a plain system service.

This rules out the generic service libs regardless of their maintenance state.

## Recommended design (if/when we build it)

A small in-repo TS module, single API across platforms:

- `install / uninstall / start / stop / status / logs`
- **Windows:** generate + register an interactive schtask (reuse
  `install-schtask.ps1` logic; can be invoked remotely via winrpc `POST /shell`).
- **Linux:** emit a `systemctl --user` unit with `DISPLAY`/`XAUTHORITY` set.
- Shell out to `schtasks` / `Register-ScheduledTask` and `systemctl --user`;
  no native addons, no `nssm`.

Estimated size: a few hundred lines. The Windows half already exists as
PowerShell, so this is mostly a thin TS controller + a Linux unit template.

## Sources

- https://github.com/munogu/node-service
- https://github.com/coreybutler/node-windows
- https://github.com/coreybutler/node-linux/issues/10
- https://github.com/NeuraLegion/node-os-service
- https://www.npmjs.com/package/service-systemd
- https://medium.com/craftsmenltd/building-a-cross-platform-background-service-in-node-js-791cfcd3be60
