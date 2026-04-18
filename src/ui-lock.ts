/**
 * Cross-process file-based UI mutex.
 *
 * Multiple Windows automation clients (wx-cli, qq-cli, …) write to the same
 * lock file so their AHK/PS operations never interleave. Any tool that wants
 * to participate just needs to acquire this lock before touching the UI.
 *
 * Lock file path (override with IM_UI_LOCK_PATH env):
 *   Windows  → C:\tmp\im-ui.lock
 *   Other    → $TMPDIR/im-ui.lock
 *
 * Acquire is atomic via O_EXCL. Expired locks are stolen automatically so
 * a crashed holder never deadlocks the machine.
 */

import { closeSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "fs";
import { join } from "path";
import { hostname } from "os";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_TTL_MS = 60_000;
const POLL_INTERVAL_MS = 100;

export interface LockState {
  holder: string;
  pid: number;
  host: string;
  acquiredAt: number;
  expiresAt: number;
  label?: string;
}

export interface LockHandle {
  state: LockState;
  release(): void;
  renew(extraMs?: number): void;
  isHeld(): boolean;
}

export function getLockPath(): string {
  if (process.env.IM_UI_LOCK_PATH) return process.env.IM_UI_LOCK_PATH;
  if (process.platform === "win32") return "C:\\tmp\\im-ui.lock";
  return join(process.env.TMPDIR || "/tmp", "im-ui.lock");
}

export function readLockState(): LockState | null {
  const path = getLockPath();
  try { statSync(path); } catch { return null; }
  try {
    const state = JSON.parse(readFileSync(path, "utf-8")) as LockState;
    if (typeof state.holder !== "string" || typeof state.pid !== "number" || typeof state.expiresAt !== "number")
      return null;
    return state;
  } catch { return null; }
}

export function forceUnlockUi(): LockState | null {
  const prev = readLockState();
  try { unlinkSync(getLockPath()); } catch {}
  return prev;
}

function writeLockFileExclusive(path: string, state: LockState): boolean {
  let fd: number | null = null;
  try {
    fd = openSync(path, "wx");
    writeSync(fd, JSON.stringify(state));
    return true;
  } catch (e: any) {
    if (e?.code === "EEXIST") return false;
    throw e;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

export async function acquireUiLock(
  holder: string,
  opts: { timeoutMs?: number; ttlMs?: number; label?: string } = {},
): Promise<LockHandle> {
  const path = getLockPath();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const state: LockState = {
      holder,
      pid: process.pid,
      host: hostname(),
      acquiredAt: Date.now(),
      expiresAt: Date.now() + ttlMs,
      label: opts.label,
    };

    if (writeLockFileExclusive(path, state)) {
      let released = false;
      const handle: LockHandle = {
        state,
        isHeld() { return !released && readLockState()?.pid === process.pid; },
        renew(extraMs = ttlMs) {
          if (released) return;
          const fresh = { ...state, expiresAt: Date.now() + extraMs };
          try {
            const fd = openSync(path, "w");
            writeSync(fd, JSON.stringify(fresh));
            closeSync(fd);
            state.expiresAt = fresh.expiresAt;
          } catch {}
        },
        release() {
          if (released) return;
          released = true;
          const cur = readLockState();
          if (cur?.pid === process.pid && cur.acquiredAt === state.acquiredAt)
            try { unlinkSync(path); } catch {}
        },
      };
      return handle;
    }

    const existing = readLockState();
    if (existing && existing.expiresAt < Date.now()) {
      try { unlinkSync(path); } catch {}
      continue;
    }
    if (Date.now() >= deadline) {
      const heldBy = existing
        ? `${existing.holder} (pid ${existing.pid}@${existing.host}, expires in ${Math.max(0, existing.expiresAt - Date.now())}ms)`
        : "<unknown>";
      throw new Error(`UI lock timeout after ${timeoutMs}ms waiting for ${heldBy}; want="${holder}"`);
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

export async function withUiLock<T>(
  holder: string,
  fn: (handle: LockHandle) => Promise<T>,
  opts?: { timeoutMs?: number; ttlMs?: number; label?: string },
): Promise<T> {
  const handle = await acquireUiLock(holder, opts);
  try { return await fn(handle); }
  finally { handle.release(); }
}
