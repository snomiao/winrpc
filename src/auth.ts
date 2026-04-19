/**
 * First-run token generation and Basic-auth middleware.
 *
 * On first start, generates a random 32-byte hex token, saves it to
 * <cwd>/.winrpc.token (gitignored). On subsequent starts, loads the
 * existing token.
 *
 * Clients embed the token as HTTP Basic Auth username:
 *   WINRPC_URL=http://<token>@host:port
 *
 * The server accepts:
 *   Authorization: Basic <base64(token:)>   (username=token, password empty)
 *   Authorization: Bearer <token>            (alternative)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";

const TOKEN_FILE = join(process.cwd(), ".winrpc.token");

function loadOrCreateToken(): string {
  if (existsSync(TOKEN_FILE)) {
    const t = readFileSync(TOKEN_FILE, "utf-8").trim();
    if (t.length >= 16) return t;
  }
  const token = randomBytes(32).toString("hex");
  writeFileSync(TOKEN_FILE, token + "\n", { encoding: "utf-8", mode: 0o600 });
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
  console.log("  winrpc access token (saved to .winrpc.token)");
  console.log("");
  console.log(`  WINRPC_URL=${url}`);
  console.log("");
  console.log("  Add to your .env.local on the client machine.");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("");
}
