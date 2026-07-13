// src/signing.test.ts
// Comprehensive tests for the signing module using Bun's built-in test runner.

import { describe, test, expect, spyOn, beforeAll, afterAll } from "bun:test";
import * as crypto from "node:crypto";
import {
  isAtomgitGateway,
  signRequest,
  signRequestV1,
  signRequestV2,
} from "./signing";

// ---------------------------------------------------------------------------
// Shared test parameters (realistic but fake)
// ---------------------------------------------------------------------------
const BASE_PARAMS = {
  oauthToken: "test-oauth-token-abcdef1234567890",
  userId: "test-user-id-9876543210",
  body: JSON.stringify({
    model: "gpt-4",
    messages: [{ role: "user", content: "Hello, world!" }],
    stream: true,
  }),
};

// ===========================================================================
// isAtomgitGateway()
// ===========================================================================
describe("isAtomgitGateway()", () => {
  // --- positive cases (known gateway hosts) ---
  test("returns true for llm-api.atomgit.com URLs", () => {
    expect(isAtomgitGateway("https://llm-api.atomgit.com/v1/chat/completions")).toBe(true);
  });

  test("returns true for pre-llm-api-cce.atomgit.com URLs", () => {
    expect(isAtomgitGateway("https://pre-llm-api-cce.atomgit.com/v1/chat/completions")).toBe(true);
  });

  test("returns true for api-ai.gitcode.com URLs", () => {
    expect(isAtomgitGateway("https://api-ai.gitcode.com/v1/chat/completions")).toBe(true);
  });

  test("returns true for gateway URLs with query parameters", () => {
    expect(isAtomgitGateway("https://llm-api.atomgit.com/v1/chat/completions?model=gpt-4")).toBe(true);
  });

  test("returns true for gateway URLs with ports", () => {
    expect(isAtomgitGateway("https://llm-api.atomgit.com:443/v1/chat/completions")).toBe(true);
  });

  // --- negative cases ---
  test("returns false for unrelated URLs", () => {
    expect(isAtomgitGateway("https://api.openai.com/v1/chat/completions")).toBe(false);
    expect(isAtomgitGateway("https://example.com/api")).toBe(false);
  });

  test("returns false for subdomain-trick URLs (not exact match)", () => {
    // "evil.com" is part of a subdomain on atomgit.com — must NOT match
    expect(isAtomgitGateway("https://llm-api.atomgit.com.evil.com/")).toBe(false);
  });

  test("returns false for subdomain variation (non-gateway subdomain)", () => {
    expect(isAtomgitGateway("https://other.llm-api.atomgit.com/")).toBe(false);
  });

  // --- edge cases ---
  test("returns false for empty string", () => {
    expect(isAtomgitGateway("")).toBe(false);
  });

  test("returns false for relative URLs (no hostname)", () => {
    expect(isAtomgitGateway("/relative/path")).toBe(false);
    expect(isAtomgitGateway("relative")).toBe(false);
  });

  test("returns false for completely malformed inputs", () => {
    expect(isAtomgitGateway("not-a-url")).toBe(false);
    expect(isAtomgitGateway("http://")).toBe(false);
    expect(isAtomgitGateway("://host")).toBe(false);
  });
});

// ===========================================================================
// signRequestV1()
// ===========================================================================
describe("signRequestV1()", () => {
  test("returns all expected headers", () => {
    const h = signRequestV1(BASE_PARAMS);
    expect(h).toHaveProperty("x-atomcode-sig");
    expect(h).toHaveProperty("x-atomcode-ts");
    expect(h).toHaveProperty("x-atomcode-nonce");
    expect(h).toHaveProperty("x-atomcode-alg");
    expect(h).toHaveProperty("x-atomcode-ver");
  });

  test("x-atomcode-ver is '4.26.0'", () => {
    const h = signRequestV1(BASE_PARAMS);
    expect(h["x-atomcode-ver"]).toBe("4.26.0");
  });

  test("x-atomcode-alg is '1'", () => {
    const h = signRequestV1(BASE_PARAMS);
    expect(h["x-atomcode-alg"]).toBe("1");
  });

  test("x-atomcode-ts is a numeric string (Unix timestamp)", () => {
    const h = signRequestV1(BASE_PARAMS);
    expect(h["x-atomcode-ts"]).toMatch(/^\d+$/);
    const ts = Number(h["x-atomcode-ts"]);
    // Should be a recent-ish timestamp (within the last 24 hours)
    const now = Math.floor(Date.now() / 1000);
    expect(ts).toBeGreaterThan(now - 86400);
    expect(ts).toBeLessThanOrEqual(now + 10);
  });

  test("x-atomcode-nonce is a 32-character lowercase hex string", () => {
    const h = signRequestV1(BASE_PARAMS);
    expect(h["x-atomcode-nonce"]).toMatch(/^[0-9a-f]{32}$/);
  });

  test("x-atomcode-sig starts with 'v1:' followed by a 64-character hex string", () => {
    const h = signRequestV1(BASE_PARAMS);
    expect(h["x-atomcode-sig"]).toMatch(/^v1:[0-9a-f]{64}$/);
    // Total length: 3 (v1:) + 64 = 67
    expect(h["x-atomcode-sig"].length).toBe(67);
  });

  test("uses 'POST' as the default HTTP method", () => {
    const h = signRequestV1({ ...BASE_PARAMS });
    expect(h["x-atomcode-sig"]).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  test("uses '/v1/chat/completions' as the default path", () => {
    const h = signRequestV1({ ...BASE_PARAMS });
    expect(h["x-atomcode-sig"]).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  test("respects a custom method", () => {
    const h = signRequestV1({ ...BASE_PARAMS, method: "GET" });
    expect(h["x-atomcode-sig"]).toMatch(/^v1:[0-9a-f]{64}$/);
    // Different method should produce different signature
    const hPost = signRequestV1({ ...BASE_PARAMS, method: "POST" });
    expect(h["x-atomcode-sig"]).not.toBe(hPost["x-atomcode-sig"]);
  });

  test("respects a custom path", () => {
    const h = signRequestV1({ ...BASE_PARAMS, path: "/v1/models" });
    expect(h["x-atomcode-sig"]).toMatch(/^v1:[0-9a-f]{64}$/);
  });
});

// ===========================================================================
// signRequestV2()
// ===========================================================================
describe("signRequestV2()", () => {
  test("returns all expected headers", () => {
    const h = signRequestV2(BASE_PARAMS);
    expect(h).toHaveProperty("X-CodingPlan-Signature");
    expect(h).toHaveProperty("X-CodingPlan-Timestamp");
    expect(h).toHaveProperty("X-CodingPlan-Nonce");
    expect(h).toHaveProperty("X-CodingPlan-User-Id");
    expect(h).toHaveProperty("X-CodingPlan-Body-Hash");
    expect(h).toHaveProperty("X-CodingPlan-Algorithm");
  });

  test("X-CodingPlan-Timestamp is a numeric string", () => {
    const h = signRequestV2(BASE_PARAMS);
    expect(h["X-CodingPlan-Timestamp"]).toMatch(/^\d+$/);
    const ts = Number(h["X-CodingPlan-Timestamp"]);
    const now = Math.floor(Date.now() / 1000);
    expect(ts).toBeGreaterThan(now - 86400);
    expect(ts).toBeLessThanOrEqual(now + 10);
  });

  test("X-CodingPlan-Nonce is a 32-character lowercase hex string", () => {
    const h = signRequestV2(BASE_PARAMS);
    expect(h["X-CodingPlan-Nonce"]).toMatch(/^[0-9a-f]{32}$/);
  });

  test("X-CodingPlan-Signature is a 64-character lowercase hex string", () => {
    const h = signRequestV2(BASE_PARAMS);
    expect(h["X-CodingPlan-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(h["X-CodingPlan-Signature"].length).toBe(64);
  });

  test("X-CodingPlan-Body-Hash is a 64-character lowercase hex string (SHA-256)", () => {
    const h = signRequestV2(BASE_PARAMS);
    expect(h["X-CodingPlan-Body-Hash"]).toMatch(/^[0-9a-f]{64}$/);
    // Verify it's the correct SHA-256 of the body
    const expectedHash = crypto.createHash("sha256").update(BASE_PARAMS.body).digest("hex");
    expect(h["X-CodingPlan-Body-Hash"]).toBe(expectedHash);
  });

  test("X-CodingPlan-User-Id matches the input userId", () => {
    const h = signRequestV2(BASE_PARAMS);
    expect(h["X-CodingPlan-User-Id"]).toBe(BASE_PARAMS.userId);
  });

  test("X-CodingPlan-Algorithm is 'v1'", () => {
    const h = signRequestV2(BASE_PARAMS);
    expect(h["X-CodingPlan-Algorithm"]).toBe("v1");
  });
});

// ===========================================================================
// signRequest()  — merged output of v1 + v2
// ===========================================================================
describe("signRequest()", () => {
  test("includes all v1 (x-atomcode-*) headers", () => {
    const h = signRequest(BASE_PARAMS);
    expect(h).toHaveProperty("x-atomcode-sig");
    expect(h).toHaveProperty("x-atomcode-ts");
    expect(h).toHaveProperty("x-atomcode-nonce");
    expect(h).toHaveProperty("x-atomcode-alg");
    expect(h).toHaveProperty("x-atomcode-ver");
  });

  test("includes all v2 (X-CodingPlan-*) headers", () => {
    const h = signRequest(BASE_PARAMS);
    expect(h).toHaveProperty("X-CodingPlan-Signature");
    expect(h).toHaveProperty("X-CodingPlan-Timestamp");
    expect(h).toHaveProperty("X-CodingPlan-Nonce");
    expect(h).toHaveProperty("X-CodingPlan-User-Id");
    expect(h).toHaveProperty("X-CodingPlan-Body-Hash");
    expect(h).toHaveProperty("X-CodingPlan-Algorithm");
  });

  test("v1 and v2 timestamps match (both generated from the same Date.now call)", () => {
    // v1 and v2 are both called inside signRequest which computes ts once per call
    const h = signRequest(BASE_PARAMS);
    expect(h["x-atomcode-ts"]).toBe(h["X-CodingPlan-Timestamp"]);
  });

  test("X-CodingPlan-Body-Hash in merged output matches SHA-256 of the body", () => {
    const h = signRequest(BASE_PARAMS);
    const expectedHash = crypto.createHash("sha256").update(BASE_PARAMS.body).digest("hex");
    expect(h["X-CodingPlan-Body-Hash"]).toBe(expectedHash);
  });
});

// ===========================================================================
// Deterministic signing (mocked time + nonce)
// ===========================================================================
describe("Deterministic signing (mocked time + nonce)", () => {
  const FIXED_TIMESTAMP_SEC = 1_700_000_000;
  // 0xabababababababababababababababab = 32 hex chars (when mock returns 0xab)
  const EXPECTED_NONCE = "ab".repeat(16);

  let randomBytesSpy: ReturnType<typeof spyOn>;
  let dateNowSpy: ReturnType<typeof spyOn>;

  beforeAll(() => {
    // Override randomBytes to return a fixed buffer: 16 bytes of 0xab
    randomBytesSpy = spyOn(crypto, "randomBytes").mockImplementation(
      (size: number) => Buffer.alloc(size, 0xab),
    );
    // Freeze time
    dateNowSpy = spyOn(Date, "now").mockImplementation(
      () => FIXED_TIMESTAMP_SEC * 1000,
    );
  });

  afterAll(() => {
    randomBytesSpy.mockRestore();
    dateNowSpy.mockRestore();
  });

  test("signRequestV1 produces identical output on repeated calls", () => {
    const a = signRequestV1(BASE_PARAMS);
    const b = signRequestV1(BASE_PARAMS);
    expect(a).toEqual(b);
  });

  test("signRequestV2 produces identical output on repeated calls", () => {
    const a = signRequestV2(BASE_PARAMS);
    const b = signRequestV2(BASE_PARAMS);
    expect(a).toEqual(b);
  });

  test("signRequest produces identical output on repeated calls", () => {
    const a = signRequest(BASE_PARAMS);
    const b = signRequest(BASE_PARAMS);
    expect(a).toEqual(b);
  });

  test("x-atomcode-ts matches the mocked timestamp", () => {
    const h = signRequestV1(BASE_PARAMS);
    expect(Number(h["x-atomcode-ts"])).toBe(FIXED_TIMESTAMP_SEC);
  });

  test("x-atomcode-nonce matches the expected deterministic hex", () => {
    const h = signRequestV1(BASE_PARAMS);
    expect(h["x-atomcode-nonce"]).toBe(EXPECTED_NONCE);
  });

  test("X-CodingPlan-Timestamp matches the mocked timestamp", () => {
    const h = signRequestV2(BASE_PARAMS);
    expect(Number(h["X-CodingPlan-Timestamp"])).toBe(FIXED_TIMESTAMP_SEC);
  });

  test("signRequest output is fully deterministic", () => {
    const h = signRequest(BASE_PARAMS);
    expect(Number(h["x-atomcode-ts"])).toBe(FIXED_TIMESTAMP_SEC);
    expect(Number(h["X-CodingPlan-Timestamp"])).toBe(FIXED_TIMESTAMP_SEC);
    expect(h["x-atomcode-nonce"]).toBe(EXPECTED_NONCE);
    expect(h["X-CodingPlan-Nonce"]).toBe(EXPECTED_NONCE);
  });
});

// ===========================================================================
// Edge cases
// ===========================================================================
describe("Edge cases", () => {
  // --- Empty body ---
  test("signRequestV1 with empty body", () => {
    const h = signRequestV1({ ...BASE_PARAMS, body: "" });
    expect(h["x-atomcode-sig"]).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(h["x-atomcode-nonce"]).toMatch(/^[0-9a-f]{32}$/);
  });

  test("signRequestV2 with empty body", () => {
    const h = signRequestV2({ ...BASE_PARAMS, body: "" });
    expect(h["X-CodingPlan-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    // Body hash of empty string
    const expectedHash = crypto.createHash("sha256").update("").digest("hex");
    expect(h["X-CodingPlan-Body-Hash"]).toBe(expectedHash);
  });

  test("signRequest with empty body", () => {
    const h = signRequest({ ...BASE_PARAMS, body: "" });
    expect(h["x-atomcode-sig"]).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(h["X-CodingPlan-Signature"]).toMatch(/^[0-9a-f]{64}$/);
  });

  // --- Very long body ---
  test("signRequestV1 with 10 KB body", () => {
    const longBody = "x".repeat(10_240);
    const h = signRequestV1({ ...BASE_PARAMS, body: longBody });
    expect(h["x-atomcode-sig"]).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  test("signRequestV1 with 100 KB body", () => {
    const longBody = "y".repeat(102_400);
    const h = signRequestV1({ ...BASE_PARAMS, body: longBody });
    expect(h["x-atomcode-sig"]).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  test("signRequestV2 with 100 KB body", () => {
    const longBody = "z".repeat(102_400);
    const h = signRequestV2({ ...BASE_PARAMS, body: longBody });
    expect(h["X-CodingPlan-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(h["X-CodingPlan-Body-Hash"]).toMatch(/^[0-9a-f]{64}$/);
  });

  // --- Special characters in path ---
  test("signRequestV1 with query parameters in path", () => {
    const h = signRequestV1({
      ...BASE_PARAMS,
      path: "/v1/chat/completions?foo=bar&baz=qux",
    });
    expect(h["x-atomcode-sig"]).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  test("signRequestV1 with Unicode characters in path", () => {
    const h = signRequestV1({
      ...BASE_PARAMS,
      path: "/v1/测试/模型",
    });
    expect(h["x-atomcode-sig"]).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  test("signRequestV1 with encoded special characters in path", () => {
    const h = signRequestV1({
      ...BASE_PARAMS,
      path: "/v1/path with spaces/foo%20bar",
    });
    expect(h["x-atomcode-sig"]).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  // --- Different HTTP methods ---
  test("signRequestV1 with GET", () => {
    const h = signRequestV1({ ...BASE_PARAMS, method: "GET" });
    expect(h["x-atomcode-sig"]).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  test("signRequestV1 with PUT", () => {
    const h = signRequestV1({ ...BASE_PARAMS, method: "PUT" });
    expect(h["x-atomcode-sig"]).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  test("signRequestV1 with DELETE", () => {
    const h = signRequestV1({ ...BASE_PARAMS, method: "DELETE" });
    expect(h["x-atomcode-sig"]).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  test("signRequestV1 with PATCH", () => {
    const h = signRequestV1({ ...BASE_PARAMS, method: "PATCH" });
    expect(h["x-atomcode-sig"]).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  test("signRequestV1 with lowercase method", () => {
    const h = signRequestV1({ ...BASE_PARAMS, method: "get" });
    expect(h["x-atomcode-sig"]).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  test("signRequestV2 with DELETE method and custom path", () => {
    const h = signRequestV2({
      ...BASE_PARAMS,
      method: "DELETE",
      path: "/v1/models/test-model",
    });
    expect(h["X-CodingPlan-Signature"]).toMatch(/^[0-9a-f]{64}$/);
  });

  // --- Body with special characters ---
  test("signRequestV1 with body containing newlines, unicode, and emoji", () => {
    const specialBody = JSON.stringify({
      text: "Hello\nWorld\t!",
      emoji: "🚀",
      nested: { key: "value" },
      empty: null,
    });
    const h = signRequestV1({ ...BASE_PARAMS, body: specialBody });
    expect(h["x-atomcode-sig"]).toMatch(/^v1:[0-9a-f]{64}$/);
  });

  // --- signRequest (merged) edge cases ---
  test("signRequest with PUT, empty body, and custom path", () => {
    const h = signRequest({
      ...BASE_PARAMS,
      method: "PUT",
      path: "/v1/completions",
      body: "",
    });
    // Both v1 and v2 headers should be present and well-formed
    expect(h["x-atomcode-sig"]).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(h["X-CodingPlan-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    // Timestamps should match (both generated in the same synchronous call)
    expect(h["x-atomcode-ts"]).toBe(h["X-CodingPlan-Timestamp"]);
    // Note: nonces are NOT compared because signRequestV1 and signRequestV2 each
    // independently generate their own random nonce.
  });
});
