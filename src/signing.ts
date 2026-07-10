// src/signing.ts
// HMAC signing for AtomGit LLM gateway requests.
// Based on reverse-engineered protocol observed from atomcode 4.26.0.
//
// Canonical message: POST\nPATH\nSHA256(BODY)\nTOKEN\nUSER_ID\nTS\nNONCE
// Key derivation:   HMAC(HMAC("atomcode-codingplan-v1", token), "signing-key-derivation")
//
// Header names match atomcode v4.26.0 capture (x-atomcode-*).
// If gateway rejects, also supports X-CodingPlan-* fallback (CoffeeCat138 format).

import * as crypto from "node:crypto";

export function isAtomgitGateway(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === "llm-api.atomgit.com" ||
           host === "pre-llm-api-cce.atomgit.com" ||
           host === "api-ai.gitcode.com";
  } catch {
    return false;
  }
}

export interface SignParams {
  oauthToken: string;
  userId: string;
  body: string;
  path?: string;
  method?: string;
}

export interface SignedHeaders {
  [key: string]: string;
}

/**
 * Derive signing key from OAuth token using dual HMAC.
 * Based on CoffeeCat138/Atomcode-proxy's signing.ts.
 */
function deriveSigningKey(oauthToken: string): Buffer {
  const intermediate = crypto
    .createHmac("sha256", "atomcode-codingplan-v1")
    .update(oauthToken)
    .digest();
  return crypto
    .createHmac("sha256", intermediate)
    .update("signing-key-derivation")
    .digest();
}

function buildCanonicalMessage(
  method: string, path: string, body: string,
  oauthToken: string, userId: string,
  timestamp: string, nonceHex: string
): string {
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  return [method, path, bodyHash, oauthToken, userId, timestamp, nonceHex].join("\n");
}

/**
 * Sign a request using the atomcode v4.26.0 header convention.
 * Headers: x-atomcode-sig, x-atomcode-ts, x-atomcode-nonce, x-atomcode-alg, x-atomcode-ver
 */
export function signRequestV1(params: SignParams): SignedHeaders {
  const method = params.method || "POST";
  const path = params.path || "/v1/chat/completions";
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16);
  const nonceHex = nonce.toString("hex");
  const ver = "4.26.0";

  const signingKey = deriveSigningKey(params.oauthToken);
  const message = buildCanonicalMessage(
    method, path, params.body,
    params.oauthToken, params.userId,
    ts.toString(), nonceHex
  );

  const sig = crypto.createHmac("sha256", signingKey).update(message).digest("hex");

  return {
    "x-atomcode-sig": `v1:${sig}`,
    "x-atomcode-ts": ts.toString(),
    "x-atomcode-nonce": nonceHex,
    "x-atomcode-alg": "1",
    "x-atomcode-ver": ver,
  };
}

/**
 * Sign a request using CoffeeCat138/X-CodingPlan-* header convention.
 * Some gateway versions may accept this format.
 */
export function signRequestV2(params: SignParams): SignedHeaders {
  const method = params.method || "POST";
  const path = params.path || "/v1/chat/completions";
  const ts = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(16);
  const nonceHex = nonce.toString("hex");

  const bodyHash = crypto.createHash("sha256").update(params.body).digest("hex");

  // CoffeeCat138: no user_id in message, different canonical format
  // Actually they DO include user_id. Let me match their exact format.
  const signingKey = deriveSigningKey(params.oauthToken);
  const message = [method, path, bodyHash, params.oauthToken, params.userId, ts.toString(), nonceHex].join("\n");
  const sig = crypto.createHmac("sha256", signingKey).update(message).digest("hex");

  return {
    "X-CodingPlan-Signature": sig,
    "X-CodingPlan-Timestamp": ts.toString(),
    "X-CodingPlan-Nonce": nonceHex,
    "X-CodingPlan-User-Id": params.userId,
    "X-CodingPlan-Body-Hash": bodyHash,
    "X-CodingPlan-Algorithm": "v1",
  };
}

/**
 * Sign request using both conventions — try atomcode format first,
 * and also include the CodingPlan format headers.
 * The gateway should accept at least one.
 */
export function signRequest(params: SignParams): SignedHeaders {
  // Try v1 (atomcode format, matches our capture)
  const v1Headers = signRequestV1(params);
  // Also include v2 (CoffeeCat138 format) as fallback
  const v2Headers = signRequestV2(params);
  return { ...v1Headers, ...v2Headers };
}
