/**
 * Token-based Basic/Bearer auth.
 *
 * Reads WINRPC_TOKEN from the environment (Bun auto-loads .env.local).
 * On first start — when WINRPC_TOKEN is unset — generates a 32-byte hex
 * token and appends it to ./.env.local so subsequent starts reuse it.
 *
 * Clients embed the token as HTTP Basic Auth username:
 *   WINRPC_URL=http://<token>@host:port
 *
 * The server accepts:
 *   Authorization: Basic <base64(token:)>   (username=token, password empty)
 *   Authorization: Bearer <token>            (alternative)
 */

import { existsSync, readFileSync, appendFileSync, writeFileSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

const ENV_FILE = join(process.cwd(), ".env.local");

function loadOrCreateToken(): string {
  const existing = process.env.WINRPC_TOKEN?.trim();
  if (existing && existing.length >= 16) return existing;

  const token = randomBytes(32).toString("hex");
  const line = `WINRPC_TOKEN=${token}\n`;
  if (existsSync(ENV_FILE)) {
    const cur = readFileSync(ENV_FILE, "utf-8");
    appendFileSync(ENV_FILE, (cur.endsWith("\n") || cur === "" ? "" : "\n") + line);
  } else {
    writeFileSync(ENV_FILE, line, { encoding: "utf-8", mode: 0o600 });
  }
  process.env.WINRPC_TOKEN = token;
  return token;
}

export const TOKEN = loadOrCreateToken();

/** Extract token from Authorization header (Basic or Bearer). */
function extractToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  if (authHeader.startsWith("Bearer ")) return authHeader.slice(7).trim();
  if (authHeader.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf-8");
    // Basic auth URL format: token: (username=token, password empty)
    return decoded.split(":")[0].trim() || null;
  }
  return null;
}

/** Returns 401 response if token is missing or wrong, null if OK. */
export function checkAuth(authHeader: string | null): Response | null {
  const provided = extractToken(authHeader);
  if (!provided || provided !== TOKEN) {
    return new Response("Unauthorized — include access token in URL: http://<token>@host:port", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="winrpc"' },
    });
  }
  return null;
}

/** Print the startup URL banner so the user can copy-paste the env var. */
export function printTokenBanner(host: string, port: number) {
  const url = `http://${TOKEN}@${host === "0.0.0.0" ? "localhost" : host}:${port}`;
  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  winrpc access token (WINRPC_TOKEN in ./.env.local)");
  console.log("");
  console.log(`  WINRPC_URL=${url}`);
  console.log("");
  console.log("  Add to your .env.local on the client machine.");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");
}
