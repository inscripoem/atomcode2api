import { createMiddleware } from "hono/factory";
import { getCookie } from "hono/cookie";
import crypto from "node:crypto";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const COOKIE_NAME = "dashboard_token";

const sessions = new Map<string, { createdAt: number }>();

// ── Helpers ────────────────────────────────────────────

export function isEnabled(): boolean {
  return !!process.env.DASHBOARD_PASSWORD;
}

/**
 * Create a session, store it in-memory, and return the token.
 */
export function createSession(): string {
  const token = crypto.randomUUID();
  sessions.set(token, { createdAt: Date.now() });
  return token;
}

/**
 * Validate a session token: exists and not expired (24h max age).
 * Expired tokens are removed and return false.
 */
export function validateSession(token: string): boolean {
  const session = sessions.get(token);
  if (!session) return false;

  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return false;
  }

  return true;
}

/**
 * Destroy (remove) a session token from the store.
 */
export function destroySession(token: string): void {
  sessions.delete(token);
}

/**
 * Verify a password against DASHBOARD_PASSWORD using timing-safe comparison.
 */
export function verifyPassword(password: string): boolean {
  const expected = process.env.DASHBOARD_PASSWORD ?? "";
  if (expected.length === 0) return false;

  const actual = Buffer.from(password);
  const expectedBuf = Buffer.from(expected);

  if (actual.length !== expectedBuf.length) {
    // Timing-safe even with length mismatch: compare the shorter against itself
    const minLen = Math.min(actual.length, expectedBuf.length);
    const dummy = Buffer.alloc(minLen, 0);
    return crypto.timingSafeEqual(dummy, expectedBuf.subarray(0, minLen)) && false;
  }

  return crypto.timingSafeEqual(actual, expectedBuf);
}

// ── Middleware ─────────────────────────────────────────

/**
 * Hono middleware that protects dashboard routes.
 *
 * - If DASHBOARD_PASSWORD is not set, auth is disabled — all requests pass.
 * - Otherwise, reads the `dashboard_token` cookie and validates the session.
 * - Returns 401 JSON on invalid / missing token.
 */
export const dashboardAuthMiddleware = createMiddleware(async (c, next) => {
  if (!isEnabled()) {
    await next();
    return;
  }

  const token = getCookie(c, COOKIE_NAME);

  if (!token || !validateSession(token)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  await next();
});
