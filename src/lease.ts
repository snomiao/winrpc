/**
 * UI lease: hold the UI lock across a multi-step flow (screenshot → act → screenshot …).
 *
 * Without a lease, every mutating request takes the UI lock for itself only (ui-lock.ts, 60 s), so a
 * flow of several requests can be interleaved by another client between its steps.
 *
 * - acquire(owner, ttl): takes the cross-process UI lock (same file as the per-request lock) and keeps
 *   it. Returns a lease id (random; the holder sends it back as `X-Winrpc-Lease`). One lease at a time.
 * - While a lease is held, it SUBSUMES the per-request lock: the holder's requests run without
 *   contending for the lock again; a mutating request without that lease gets 423 + {holder, expires_at}.
 * - Bounded: every acquire/renew is capped at MAX_TTL_MS, a lease never lives longer than
 *   MAX_LIFETIME_MS in total, and it is released automatically when its TTL runs out (the holder
 *   stopped renewing: crashed, lost, or forgot). The lock file carries the same expiry, so other
 *   processes steal it after expiry even if this server dies.
 * - Which endpoints a lease guards is configuration (WINRPC_LEASE_GUARDS, default
 *   "ahk-eval,run-template,shell,screenshot-window"); full-screen /screenshot and read-only probes stay outside (they cannot break
 *   the holder's flow, and they keep the screen observable during long flows).
 */

import { randomBytes, timingSafeEqual } from "crypto";
import { acquireUiLock, readLockState, type LockHandle } from "./ui-lock";

export const MAX_TTL_MS = 10 * 60_000;
export const MAX_LIFETIME_MS = 60 * 60_000;
export const DEFAULT_TTL_MS = 2 * 60_000;
// "screenshot-window": /screenshot?window=|process= brings the window to the front (a full-screen
// /screenshot is read-only and never guarded).
export const DEFAULT_GUARDS = ["ahk-eval", "run-template", "shell", "screenshot-window"];

export function leaseGuards(env: Record<string, string | undefined> = process.env): Set<string> {
  const raw = env.WINRPC_LEASE_GUARDS;
  if (raw === undefined) return new Set(DEFAULT_GUARDS);
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

export interface LeaseInfo {
  owner: string;
  label?: string;
  acquired_at: string;
  expires_at: string;
}

interface Lease {
  id: string;
  owner: string;
  label?: string;
  acquiredAt: number;
  expiresAt: number;
  handle: LockHandle;
  timer: ReturnType<typeof setTimeout>;
  /** holder actions running now (at most 1: they run in the server's queue) */
  busy: number;
  /** stops the heartbeat that keeps the file lock alive while an action runs */
  stopBeat?: () => void;
}

/** While a holder action runs, the file lock is kept at least this far ahead (renewed every 15 s). */
const BEAT_AHEAD_MS = 60_000;

export type Held = { held: true; info: LeaseInfo };

let current: Lease | null = null;
let clock = () => Date.now();

/** Tests only: a fake clock. */
export function _setClock(fn: () => number) {
  clock = fn;
}

function info(l: Lease): LeaseInfo {
  return {
    owner: l.owner,
    label: l.label,
    acquired_at: new Date(l.acquiredAt).toISOString(),
    expires_at: new Date(l.expiresAt).toISOString(),
  };
}

function clampTtl(ttlMs: number | undefined, acquiredAt: number, now: number): number {
  const want = Math.max(1_000, Math.min(ttlMs ?? DEFAULT_TTL_MS, MAX_TTL_MS));
  return Math.min(want, acquiredAt + MAX_LIFETIME_MS - now);
}

function schedule(l: Lease) {
  clearTimeout(l.timer);
  l.timer = setTimeout(() => expire(l.id), Math.max(0, l.expiresAt - clock()));
}

function drop(l: Lease) {
  clearTimeout(l.timer);
  l.stopBeat?.();
  l.handle.release();
  if (current?.id === l.id) current = null;
}

/**
 * Auto-release: the TTL ran out without a renew. A holder action still running keeps the file lock
 * (its heartbeat started with the action), and the lease is dropped when that action ends.
 */
function expire(id: string) {
  if (current?.id !== id) return;
  if (current.expiresAt > clock()) return schedule(current);
  if (current.busy === 0) drop(current);
}

/** The active lease: none once its TTL passed (timers can be late); dropped unless an action still runs. */
export function activeLease(): LeaseInfo | null {
  if (current && current.expiresAt <= clock()) {
    if (current.busy === 0) drop(current);
    return null;
  }
  return current ? info(current) : null;
}

function sameId(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Does this request's lease header match the active (unexpired) lease? */
export function isHolder(leaseId: string | null | undefined): boolean {
  return !!(activeLease() && current && leaseId && sameId(current.id, leaseId));
}

export type Gate =
  | { kind: "free" }
  | { kind: "holder"; done: () => void }
  | { kind: "blocked"; info: LeaseInfo };

/**
 * Decide a guarded request when it is about to run (at dequeue, not when it arrived):
 * free (no lease), holder (runs inside the lease; call done() when the action ends), or blocked (423).
 */
export function gate(leaseId: string | null | undefined): Gate {
  const held = activeLease();
  if (!held || !current) return { kind: "free" };
  if (!leaseId || !sameId(current.id, leaseId)) return { kind: "blocked", info: held };
  const l = current;
  l.busy += 1;
  // Protect the action from its first moment, for as long as it runs: the file lock is kept at least
  // BEAT_AHEAD_MS ahead (or to the lease's own expiry if later), renewed every 15 s.
  if (l.busy === 1) {
    const beat = () => l.handle.renew(Math.max(BEAT_AHEAD_MS, l.expiresAt - clock()));
    if (!beat()) {
      // the lock is no longer ours (taken over after an expiry): the lease is lost, the request runs
      // like any other, with its own per-request lock
      l.busy -= 1;
      drop(l);
      return { kind: "free" };
    }
    const t = setInterval(() => {
      if (!beat()) clearInterval(t); // lost mid-action: stop renewing (never write another holder's lock)
    }, 15_000);
    l.stopBeat = () => clearInterval(t);
  }
  let ended = false;
  return {
    kind: "holder",
    done() {
      if (ended) return;
      ended = true;
      l.busy -= 1;
      if (l.busy > 0) return;
      l.stopBeat?.();
      l.stopBeat = undefined;
      if (current?.id !== l.id) return;
      if (l.expiresAt <= clock()) drop(l);
      else l.handle.renew(l.expiresAt - clock()); // back to the lease's own expiry
    },
  };
}

export async function acquireLease(opts: {
  owner: string;
  label?: string;
  ttlMs?: number;
  waitMs?: number;
}): Promise<{ lease: string } & LeaseInfo | Held> {
  const held = activeLease();
  if (held) return { held: true, info: held };
  if (current) return { held: true, info: info(current) }; // expired, its last action still running
  const ttl = clampTtl(opts.ttlMs, clock(), clock());
  let handle: LockHandle;
  try {
    handle = await acquireUiLock(`lease:${opts.owner}`, {
      timeoutMs: Math.max(0, Math.min(opts.waitMs ?? 30_000, 60_000)),
      ttlMs: ttl,
      label: opts.label,
    });
  } catch {
    // another process holds the file lock (a client of its own, or a stuck per-request call)
    const st = readLockState();
    return {
      held: true,
      info: {
        owner: st?.holder ?? "(unknown)",
        label: st?.label,
        acquired_at: st ? new Date(st.acquiredAt).toISOString() : "",
        expires_at: st ? new Date(st.expiresAt).toISOString() : "",
      },
    };
  }
  // Re-check: a concurrent acquire in this process may have won while we waited.
  if (current) {
    handle.release();
    return { held: true, info: info(current) };
  }
  // The lifetime starts when the lock is ours (the wait above may have taken seconds); the lock file gets
  // the same expiry.
  const now = clock();
  if (!handle.renew(ttl)) {
    handle.release();
    return { held: true, info: { owner: "(lock lost while starting)", acquired_at: "", expires_at: "" } };
  }
  const l: Lease = {
    id: randomBytes(16).toString("hex"),
    owner: opts.owner,
    label: opts.label,
    acquiredAt: now,
    expiresAt: handle.state.expiresAt, // exactly the lock file's expiry
    handle,
    timer: setTimeout(() => {}, 0),
    busy: 0,
  };
  current = l;
  schedule(l);
  return { lease: l.id, ...info(l) };
}

export function renewLease(leaseId: string, ttlMs?: number): LeaseInfo | null {
  if (!isHolder(leaseId) || !current) return null;
  const now = clock();
  const ttl = clampTtl(ttlMs, current.acquiredAt, now);
  if (ttl <= 0) {
    drop(current);
    return null;
  }
  // never below the heartbeat's margin while an action runs; the new expiry counts only once written
  if (!current.handle.renew(current.busy > 0 ? Math.max(ttl, BEAT_AHEAD_MS) : ttl)) {
    if (current.busy === 0) drop(current);
    return null; // lost: 410
  }
  current.expiresAt = now + ttl;
  schedule(current);
  return info(current);
}

export function releaseLease(leaseId: string): boolean {
  if (!isHolder(leaseId) || !current) return false;
  if (current.busy > 0) {
    // the holder's own action is still running (its heartbeat keeps the lock): end the lease now,
    // free the lock when the action finishes
    current.expiresAt = clock();
    clearTimeout(current.timer);
    return true;
  }
  drop(current);
  return true;
}

/** force-unlock also ends a lease (admin escape hatch). */
export function dropLease(): LeaseInfo | null {
  if (!current) return null;
  const i = info(current);
  drop(current);
  return i;
}
