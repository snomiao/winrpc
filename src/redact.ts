/**
 * Keep the access token out of anything winrpc prints (help, errors, banners, debug).
 *
 * - redactUrl: `http://<token>@host:port` → `http://***@host:port` (user and password parts).
 * - redactSecrets: every known secret value → its first 4 characters + "…".
 * - installConsoleRedaction: wraps console.log/info/warn/error/debug so that, whatever a code
 *   path prints, the current token never reaches the terminal or a log file.
 */

const MIN_SECRET_LEN = 8;

export function redactUrl(s: string): string {
  return s.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@");
}

export function mask(secret: string): string {
  return `${secret.slice(0, 4)}…`;
}

/** Secrets known to this process: $WINRPC_TOKEN and the user part of $WINRPC_URL. */
export function knownSecrets(env: Record<string, string | undefined> = process.env): string[] {
  const out = new Set<string>();
  const token = env.WINRPC_TOKEN?.trim();
  if (token) out.add(token);
  const raw = env.WINRPC_URL;
  if (raw) {
    try {
      const u = new URL(raw);
      if (u.username) out.add(decodeURIComponent(u.username));
      if (u.password) out.add(decodeURIComponent(u.password));
    } catch {}
  }
  return [...out].filter((s) => s.length >= MIN_SECRET_LEN);
}

export function redactSecrets(s: string, secrets: string[] = knownSecrets()): string {
  let r = redactUrl(s);
  // Longest first, so a secret that contains another is masked whole.
  for (const sec of [...secrets].sort((a, b) => b.length - a.length)) r = r.replaceAll(sec, mask(sec));
  return r;
}

function redactArg(a: unknown, secrets: string[]): unknown {
  if (typeof a === "string") return redactSecrets(a, secrets);
  if (a instanceof Error) {
    const e = new Error(redactSecrets(a.message, secrets));
    e.name = a.name;
    if (a.stack) e.stack = redactSecrets(a.stack, secrets);
    return e;
  }
  if (a && typeof a === "object") {
    try {
      const json = JSON.stringify(a);
      const red = redactSecrets(json, secrets);
      return red === json ? a : JSON.parse(red);
    } catch {
      return a;
    }
  }
  return a;
}

let installed = false;

/** Idempotent. `extra` adds secrets that are not in the environment (e.g. a server's generated token). */
export function installConsoleRedaction(extra: () => string[] = () => []): void {
  if (installed) return;
  installed = true;
  for (const m of ["log", "info", "warn", "error", "debug"] as const) {
    const orig = console[m].bind(console);
    console[m] = (...args: unknown[]) => {
      const secrets = [...knownSecrets(), ...extra()].filter((s) => s.length >= MIN_SECRET_LEN);
      orig(...args.map((a) => redactArg(a, secrets)));
    };
  }
}
