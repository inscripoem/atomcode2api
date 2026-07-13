// codingplan.test.ts
// Tests for CodingPlan API client using Bun's built-in test runner.

import { describe, test, expect, afterEach, beforeEach } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import * as cp from "./codingplan";
import * as ts from "./token-store";

const REAL_AUTH_FILE = join(import.meta.dirname, "..", "data", "auth.json");
const REAL_CONFIG_FILE = join(import.meta.dirname, "..", "data", "config.json");

type Backup = { existed: boolean; content: string };

function backupFile(path: string): Backup {
  const existed = fs.existsSync(path);
  return { existed, content: existed ? fs.readFileSync(path, "utf-8") : "" };
}

function restoreFile(path: string, b: Backup): void {
  if (b.existed) {
    fs.writeFileSync(path, b.content, { encoding: "utf-8" });
  } else if (fs.existsSync(path)) {
    fs.writeFileSync(path, "", { encoding: "utf-8" });
  }
}

function setupAuth() {
  ts.saveAuth({
    access_token: "fake-token-123",
    token_type: "Bearer",
    created_at: Math.floor(Date.now() / 1000),
    expires_in: 86400,
    user: { id: "u1", username: "tester" },
  });
}

const originalFetch = globalThis.fetch;

// ── listModels ──────────────────────────────────────────

describe("listModels", () => {
  let authBak: Backup;

  beforeEach(() => { authBak = backupFile(REAL_AUTH_FILE); setupAuth(); });
  afterEach(() => { globalThis.fetch = originalFetch; restoreFile(REAL_AUTH_FILE, authBak); });

  test("returns ModelEntry[] with correct shape", async () => {
    const models = [
      { id: 1, display_model_name: "gpt-4", plan_available: true, context_window: 8192 },
      { id: 2, display_model_name: "claude-3", plan_available: false },
    ];

    globalThis.fetch = (async () => new Response(JSON.stringify(models), { status: 200 })) as any;
    const result = await cp.listModels("Max");

    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
    expect(result[0].display_model_name).toBe("gpt-4");
    expect(result[1].display_model_name).toBe("claude-3");
  });

  test("returns empty array when no models", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify([]), { status: 200 })) as any;
    const result = await cp.listModels("Free");
    expect(result).toEqual([]);
  });

  test("throws on 401 status", async () => {
    globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as any;
    await expect(cp.listModels("Max")).rejects.toThrow();
  });

  test("throws on non-ok status", async () => {
    globalThis.fetch = (async () => new Response("server error", { status: 500 })) as any;
    await expect(cp.listModels("Max")).rejects.toThrow();
  });
});

// ── getStatus ───────────────────────────────────────────

describe("getStatus", () => {
  let authBak: Backup;

  beforeEach(() => { authBak = backupFile(REAL_AUTH_FILE); setupAuth(); });
  afterEach(() => { globalThis.fetch = originalFetch; restoreFile(REAL_AUTH_FILE, authBak); });

  test("returns StatusResponse with correct shape", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      plan_type: "Lite",
      codingplan_free: { plan_name: "Free", remaining_days: 30 },
      rate_limit_windows: [{ calls_used: 10, call_limit: 100 }],
    }), { status: 200 })) as any;

    const result = await cp.getStatus();
    expect(result).toHaveProperty("plan_type", "Lite");
    expect(result.codingplan_free).toBeDefined();
  });

  test("returns null codingplan_free when no plan claimed", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      plan_type: "Free",
      codingplan_free: null,
      rate_limit_windows: [],
    }), { status: 200 })) as any;

    const result = await cp.getStatus();
    expect(result.codingplan_free).toBeFalsy();
  });

  test("throws on 403 status", async () => {
    globalThis.fetch = (async () => new Response("forbidden", { status: 403 })) as any;
    await expect(cp.getStatus()).rejects.toThrow();
  });

  test("throws on non-ok status", async () => {
    globalThis.fetch = (async () => new Response("error", { status: 500 })) as any;
    await expect(cp.getStatus()).rejects.toThrow();
  });
});

// ── claimPlan ───────────────────────────────────────────

describe("claimPlan", () => {
  let authBak: Backup;

  beforeEach(() => { authBak = backupFile(REAL_AUTH_FILE); setupAuth(); });
  afterEach(() => { globalThis.fetch = originalFetch; restoreFile(REAL_AUTH_FILE, authBak); });

  test("returns success response when claim succeeds", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      success: true, message: "claimed successfully", plan_name: "Pro",
    }), { status: 200 })) as any;

    const result = await cp.claimPlan("Pro");
    expect(result.success).toBe(true);
    expect(result.message).toContain("claimed");
  });

  test("returns duplicate response when plan already claimed", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({
      success: false, message: "already claimed",
    }), { status: 200 })) as any;

    const result = await cp.claimPlan("Pro");
    expect(result.success).toBe(false);
  });

  test("throws on 401 status", async () => {
    globalThis.fetch = (async () => new Response("unauthorized", { status: 401 })) as any;
    await expect(cp.claimPlan("Pro")).rejects.toThrow();
  });

  test("throws on non-ok status with error message", async () => {
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ message: "rate limited" }), { status: 429 }
    )) as any;
    await expect(cp.claimPlan("Pro")).rejects.toThrow();
  });

  test("throws on non-ok status with plain text fallback", async () => {
    globalThis.fetch = (async () => new Response("bad gateway", { status: 502 })) as any;
    await expect(cp.claimPlan("Pro")).rejects.toThrow();
  });
});
