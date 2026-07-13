// token-store.test.ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import * as ts from "./token-store";
import type { AuthData } from "./token-store";

function makeAuth(overrides: Partial<AuthData> & { created_at: number }): AuthData {
  return {
    access_token: "test-token",
    token_type: "Bearer",
    created_at: 0,
    user: { id: "1", username: "tester" },
    ...overrides,
  };
}

// ── isTokenExpired (pure arithmetic) ────────────────────

describe("isTokenExpired()", () => {
  test("returns true for token that expired long ago", () => {
    const now = Math.floor(Date.now() / 1000);
    const auth = makeAuth({ created_at: now - 7200, expires_in: 3600 });
    expect(ts.isTokenExpired(auth)).toBe(true);
  });

  test("returns false for valid recently created token", () => {
    const now = Math.floor(Date.now() / 1000);
    const auth = makeAuth({ created_at: now - 60, expires_in: 3600 });
    expect(ts.isTokenExpired(auth)).toBe(false);
  });

  test("expired at exact margin boundary (now === expiresAt - 300)", () => {
    const now = Math.floor(Date.now() / 1000);
    const auth = makeAuth({ created_at: now, expires_in: 300 });
    expect(ts.isTokenExpired(auth)).toBe(true);
  });

  test("not expired 1 second before margin threshold", () => {
    const now = Math.floor(Date.now() / 1000);
    const auth = makeAuth({ created_at: now, expires_in: 301 });
    expect(ts.isTokenExpired(auth)).toBe(false);
  });

  test("expired 1 second past margin threshold", () => {
    const now = Math.floor(Date.now() / 1000);
    const auth = makeAuth({ created_at: now, expires_in: 299 });
    expect(ts.isTokenExpired(auth)).toBe(true);
  });

  test("very old token (epoch) is expired", () => {
    const auth = makeAuth({ created_at: 0, expires_in: 3600 });
    expect(ts.isTokenExpired(auth)).toBe(true);
  });

  test("very new long-lived token is not expired", () => {
    const now = Math.floor(Date.now() / 1000);
    const auth = makeAuth({ created_at: now, expires_in: 86400 * 365 });
    expect(ts.isTokenExpired(auth)).toBe(false);
  });

  test("token without expires_in returns false", () => {
    const auth = makeAuth({ created_at: 1000 });
    expect(ts.isTokenExpired(auth)).toBe(false);
  });
});

// ── I/O: saveAuth / loadAuth / clearAuth / isLoggedIn ───

const REAL_AUTH_FILE = join(import.meta.dirname, "..", "data", "auth.json");

type Backup = { existed: boolean; content: string };

function backup(): Backup {
  const existed = fs.existsSync(REAL_AUTH_FILE);
  return { existed, content: existed ? fs.readFileSync(REAL_AUTH_FILE, "utf-8") : "" };
}

function restore(b: Backup): void {
  ts.clearAuth();
  if (b.existed) {
    fs.writeFileSync(REAL_AUTH_FILE, b.content, { encoding: "utf-8" });
  } else if (fs.existsSync(REAL_AUTH_FILE)) {
    fs.writeFileSync(REAL_AUTH_FILE, "", { encoding: "utf-8" });
    try { fs.unlinkSync(REAL_AUTH_FILE); } catch {}
  }
}

const testAuth: AuthData = {
  access_token: "at-roundtrip-123",
  refresh_token: "rt-roundtrip-456",
  token_type: "Bearer",
  expires_in: 3600,
  created_at: Math.floor(Date.now() / 1000),
  user: {
    id: "u42",
    username: "roundtrip",
    name: "Round Trip",
    email: "roundtrip@example.com",
    avatar_url: "https://example.com/avatar.png",
  },
};

describe("AuthData serialization round-trip", () => {
  let bak: Backup;

  beforeEach(() => { bak = backup(); ts.clearAuth(); });
  afterEach(() => restore(bak));

  test("save then load returns identical data", () => {
    ts.saveAuth(testAuth);
    expect(ts.loadAuth()).toEqual(testAuth);
  });

  test("clearAuth then loadAuth returns null", () => {
    ts.saveAuth(testAuth);
    ts.clearAuth();
    expect(ts.loadAuth()).toBeNull();
  });

  test("loadAuth returns null when no auth file exists", () => {
    expect(ts.loadAuth()).toBeNull();
  });

  test("save with minimal fields", () => {
    const minimal: AuthData = {
      access_token: "minimal-token",
      token_type: "Bearer",
      created_at: 5000,
      user: { id: "x", username: "minimal" },
    };
    ts.saveAuth(minimal);
    expect(ts.loadAuth()).toEqual(minimal);
  });

  test("save with extra fields preserves them", () => {
    const extra = { ...testAuth, extra_field: "extra-value" as any, another_one: 42 as any };
    ts.saveAuth(extra as any);
    const loaded = ts.loadAuth() as AuthData & Record<string, unknown>;
    expect(loaded!.extra_field).toBe("extra-value");
    expect(loaded!.another_one).toBe(42);
  });
});

describe("isLoggedIn()", () => {
  let bak: Backup;

  beforeEach(() => { bak = backup(); ts.clearAuth(); });
  afterEach(() => restore(bak));

  test("returns false when no auth file exists", () => {
    expect(ts.isLoggedIn()).toBe(false);
  });

  test("returns true after saveAuth with valid data", () => {
    ts.saveAuth({
      access_token: "login-token",
      token_type: "Bearer",
      created_at: Math.floor(Date.now() / 1000),
      user: { id: "u1", username: "login-test" },
    });
    expect(ts.isLoggedIn()).toBe(true);
  });

  test("returns false after clearAuth", () => {
    ts.saveAuth({ access_token: "t", token_type: "Bearer", created_at: 1000, user: { id: "u", username: "u" } });
    ts.clearAuth();
    expect(ts.isLoggedIn()).toBe(false);
  });
});
