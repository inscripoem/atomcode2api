// auth.test.ts
// Tests for OAuth login flow using Bun's built-in test runner.
// Uses globalThis.fetch mocking + real filesystem (backup/restore).

import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import * as auth from "./auth";
import * as ts from "./token-store";

const REAL_AUTH_FILE = join(import.meta.dirname, "..", "data", "auth.json");

type Backup = { existed: boolean; content: string };

function backupAuth(): Backup {
  const existed = fs.existsSync(REAL_AUTH_FILE);
  return { existed, content: existed ? fs.readFileSync(REAL_AUTH_FILE, "utf-8") : "" };
}

function restoreAuth(b: Backup): void {
  ts.clearAuth();
  if (b.existed) {
    fs.writeFileSync(REAL_AUTH_FILE, b.content, { encoding: "utf-8" });
  } else if (fs.existsSync(REAL_AUTH_FILE)) {
    fs.writeFileSync(REAL_AUTH_FILE, "", { encoding: "utf-8" });
  }
}

describe("startLogin", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("returns login_url and state on success", async () => {
    globalThis.fetch = (async (url: string) => {
      return new Response(JSON.stringify({
        login_url: "https://atomgit.com/oauth/authorize?client_id=xxx",
        state: "abc123",
      }));
    }) as any;

    const result = await auth.startLogin();
    expect(result.login_url).toBeString();
    expect(result.state).toBeString();
  });

  test("throws when fetch returns non-ok response", async () => {
    globalThis.fetch = (async () => new Response("error", { status: 500 })) as any;
    await expect(auth.startLogin()).rejects.toThrow();
  });
});

describe("pollLogin", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  test("returns true when {valid: true}", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ valid: true }))) as any;
    expect(await auth.pollLogin("abc")).toBe(true);
  });

  test("returns false when {valid: false}", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ valid: false }))) as any;
    expect(await auth.pollLogin("abc")).toBe(false);
  });

  test("returns false when fetch returns non-ok", async () => {
    globalThis.fetch = (async () => new Response("error", { status: 500 })) as any;
    expect(await auth.pollLogin("abc")).toBe(false);
  });
});

describe("exchangeToken", () => {
  const originalFetch = globalThis.fetch;
  let bak: Backup;

  beforeEach(() => { bak = backupAuth(); ts.clearAuth(); });
  afterEach(() => { globalThis.fetch = originalFetch; restoreAuth(bak); });

  test("returns AuthData with correct shape", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      access_token: "at-test",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "rt-test",
      user: { id: "u1", username: "testuser", name: "Test", email: "test@example.com" },
    }))) as any;

    const result = await auth.exchangeToken("state-test");
    expect(result.access_token).toBe("at-test");
    expect(result.token_type).toBe("Bearer");
    expect(result.user.id).toBe("u1");
    expect(result.user.username).toBe("testuser");
  });

  test("throws when fetch returns non-ok", async () => {
    globalThis.fetch = (async () => new Response("error", { status: 500 })) as any;
    await expect(auth.exchangeToken("state-fail")).rejects.toThrow();
  });
});
