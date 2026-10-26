/**
 * Windows system-tray companion for winrpc.
 *
 * Shows a tray icon whose colour tracks server health, plus a right-click menu
 * to copy the connection URL, open /health, inspect and force-release the UI
 * lock, and trigger a redeploy.
 *
 * Pattern lifted from sno-codehost pm2/tray.ts: Bun + the `systray2` npm
 * package, with the two 16x16 icons inlined as base64 PNG constants so a
 * windowless service needs no icon files on disk.
 *
 * Status source differs: winrpc is not managed by pm2 (it runs as a scheduled
 * task, see register-winrpc.ps1 / scripts/install-schtask.ps1), so health comes
 * from its own unauthenticated `GET /health` endpoint.
 *
 * Run:          bun src/tray.ts      (or `winrpc tray`)
 * Windowless:   wscript scripts\tray-launch.vbs
 */
import SysTray from "systray2";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

// 16x16 blue rounded square, white "W" (base64 PNG) — server reachable
const ICON_OK =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACx" +
  "jwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAD5SURBVDhPrZOtD8IwEMUrkUgcHljAYQkagcPy" +
  "D5Agwexm5lA4FA6HxJGgkCBBT2GQJFv3Qck71oTA2ErCJS97zfV+d+1SIdKok9+xSDomwt4qqRIX" +
  "wli23Fkk1U+y5blJqiwaFPQ/ksYKxiIdKyNpJOf/gN48VN1ZyB5frOHbrlSDxdPnAtaHRC33Mfvt" +
  "KVEIeHcT87oQMF1H6ujduSPCu965M8CAFAIwMmK0irgjpkEhQPo4uQAIgSkwDUDw+ihGAHRF6AtF" +
  "4Ajv+74CUPR64/D6zxgBfhAA/jAjYaQGBRNRo1vFsuXlPVkoO/BrJFv8IhmS8WzzpIsfTBqTwFQj" +
  "pSIAAAAASUVORK5CYII=";

// 16x16 red rounded square, white "W" (base64 PNG) — server unreachable
const ICON_ERR =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACx" +
  "jwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAD/SURBVDhPY2CAgsfu3g5P3X0biMEgtfft7TnA" +
  "GkGMpx6++596+P4nBT/x8L1+399fgOGpp08AuiSx+LGHbwED2FlYJInC7r4N1DfgZXLG/xdRcWA2" +
  "iAbxQexngaH/X+UWEjbg645d/z+vWQdmfz967D8IgNgfps4A8wka8K6r9//PK1fBNoLA7ydPwTaD" +
  "DAYZQtAAkJNB4G1DM9hGkGtAGkEGwbyD1wAQBgGQK0CuARkEYsO8QpQBIFtBABagIADyAro6nAaA" +
  "NCGHOIgNixmiDCAagwx44u6bgCFBJH7s4VPBcN/LS+Kpu+9zdEki8PcnXl4GkBwJMQQj2+LDMM0A" +
  "/4Fs07TYm64AAAAASUVORK5CYII=";

const PORT = parseInt(process.env.PORT ?? "12371", 10);
const BASE = `http://127.0.0.1:${PORT}`;
const POLL_INTERVAL = 5_000;
/** A wedged server must not wedge the tray. */
const REQ_TIMEOUT = 2_000;

// Menu titles double as the click-dispatch keys, so keep them as constants.
const ITEM_COPY_URL = "Copy WINRPC_URL";
const ITEM_OPEN_HEALTH = `Open ${BASE}/health`;
const ITEM_UNLOCK = "Force-unlock UI lock";
const ITEM_REDEPLOY = "Restart server (POST /redeploy)";
const ITEM_QUIT = "Quit Tray";

/**
 * Read WINRPC_TOKEN without going through src/auth.ts: importing that module
 * GENERATES and persists a token when none exists, which would let a tray
 * started before the server write a token the running server never loaded.
 * Bun auto-loads .env.local from the cwd; fall back to the repo copy so the
 * tray also works when launched from elsewhere.
 */
function readToken(): string | null {
  const fromEnv = process.env.WINRPC_TOKEN?.trim();
  if (fromEnv) return fromEnv;
  const envFile = join(import.meta.dir, "..", ".env.local");
  if (!existsSync(envFile)) return null;
  const m = readFileSync(envFile, "utf-8").match(/^\s*WINRPC_TOKEN=(.+)$/m);
  return m?.[1].trim() || null;
}

const TOKEN = readToken();

async function api<T>(path: string, method: "GET" | "POST" = "GET"): Promise<T | null> {
  try {
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
      signal: AbortSignal.timeout(REQ_TIMEOUT),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function formatUptime(seconds: number): string {
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

function winrpcUrl(): string {
  return TOKEN ? `http://${TOKEN}@localhost:${PORT}` : `http://localhost:${PORT}`;
}

function copyToClipboard(text: string) {
  const argv = process.platform === "darwin" ? ["pbcopy"] : ["clip.exe"];
  const proc = Bun.spawn(argv, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
  proc.stdin.write(text);
  proc.stdin.end();
}

function openUrl(url: string) {
  const argv = process.platform === "darwin" ? ["open", url] : ["cmd", "/c", "start", "", url];
  Bun.spawn(argv, { stdout: "ignore", stderr: "ignore" });
}

interface Health { ok: boolean; uptime: number; pid: number }
interface Lock { locked: boolean; holder?: string; pid?: number; expiresIn?: number }

async function buildMenu() {
  const health = await api<Health>("/health");
  // /lock needs the token; skip the call entirely when we have none.
  const lock = TOKEN && health ? await api<Lock>("/lock") : null;

  const status = health
    ? `winrpc :${PORT} — up ${formatUptime(health.uptime)} (pid ${health.pid})`
    : `winrpc :${PORT} — DOWN`;

  const lockLine = !health
    ? "UI lock: unknown"
    : !TOKEN
      ? "UI lock: unknown (no WINRPC_TOKEN)"
      : !lock
        ? "UI lock: unavailable"
        : lock.locked
          ? `UI lock: held by ${lock.holder ?? "?"} (pid ${lock.pid ?? "?"})`
          : "UI lock: free";

  const items = [
    { title: status, tooltip: "Status overview", enabled: false },
    SysTray.separator,
    {
      title: ITEM_COPY_URL,
      tooltip: TOKEN ? "Copy the tokenised base URL" : "No WINRPC_TOKEN found in .env.local",
      enabled: !!TOKEN,
    },
    { title: ITEM_OPEN_HEALTH, tooltip: "Open in browser", enabled: true },
    SysTray.separator,
    { title: lockLine, tooltip: "C:\\tmp\\im-ui.lock", enabled: false },
    {
      title: ITEM_UNLOCK,
      tooltip: "Release a stuck cross-process UI lock",
      enabled: !!(health && TOKEN && lock?.locked),
    },
    {
      title: ITEM_REDEPLOY,
      tooltip: "Server exits with code 2; the supervisor restarts it on latest code",
      enabled: !!(health && TOKEN),
    },
    SysTray.separator,
    { title: ITEM_QUIT, tooltip: "Exit tray icon (leaves the server running)", enabled: true },
  ];

  return { items, up: !!health };
}

function menuFor(items: any[], up: boolean) {
  return {
    icon: up ? ICON_OK : ICON_ERR,
    title: "",
    tooltip: `winrpc :${PORT} — ${up ? "up" : "down"}`,
    items,
  };
}

async function refresh(systray: SysTray) {
  const { items, up } = await buildMenu();
  await systray.sendAction({ type: "update-menu", menu: menuFor(items, up) });
}

export async function startTray() {
  const { items, up } = await buildMenu();

  const systray = new SysTray({ menu: menuFor(items, up), debug: false, copyDir: false });
  await systray.ready();

  const quit = () => {
    systray.kill(false);
    process.exit(0);
  };

  systray.onClick(async (action) => {
    switch (action.item.title) {
      case ITEM_COPY_URL:
        copyToClipboard(winrpcUrl());
        break;
      case ITEM_OPEN_HEALTH:
        openUrl(`${BASE}/health`);
        break;
      case ITEM_UNLOCK:
        await api("/lock/force-unlock", "POST");
        await refresh(systray);
        break;
      case ITEM_REDEPLOY:
        await api("/redeploy", "POST");
        await refresh(systray);
        break;
      case ITEM_QUIT:
        quit();
        break;
    }
  });

  const timer = setInterval(() => {
    refresh(systray).catch(() => undefined);
  }, POLL_INTERVAL);

  const cleanup = () => {
    clearInterval(timer);
    quit();
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

if (import.meta.main) await startTray();
