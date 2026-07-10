// src/verify-sign-v3.ts
// Systematic test: body_hash in canonical message + many key derivations
import * as crypto from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = ".";
const files = readdirSync(dir).filter(f => f.startsWith("capture-http-") && f.endsWith(".json"));
const entries = files.map(f => JSON.parse(readFileSync(join(dir, f), "utf-8")));
const oauthToken = entries[0].headers["authorization"].replace("Bearer ", "").trim();
const userId = "6918f6575c308f65ad20a999";
const deviceId = "83d5d7df-72e8-4ca3-96f6-08666231936a";

console.log(`Captures: ${entries.length}, Token: ${oauthToken}`);
console.log(`User: ${userId}, Device: ${deviceId}\n`);

// All canonical message formats to test (using body_hash)
type FmtFn = (entry: typeof entries[0]) => string;

const formats: Record<string, FmtFn> = {
  // CoffeeCat138 format
  "F1_bodyHash_token_userId_ts_nonce": (e) =>
    ["POST","/v1/chat/completions", sha256(e.body), oauthToken, userId, e.headers["x-atomcode-ts"], e.headers["x-atomcode-nonce"]].join("\n"),
  
  // Without user_id
  "F2_bodyHash_token_ts_nonce": (e) =>
    ["POST","/v1/chat/completions", sha256(e.body), oauthToken, e.headers["x-atomcode-ts"], e.headers["x-atomcode-nonce"]].join("\n"),

  // Without token in message
  "F3_bodyHash_userId_ts_nonce": (e) =>
    ["POST","/v1/chat/completions", sha256(e.body), userId, e.headers["x-atomcode-ts"], e.headers["x-atomcode-nonce"]].join("\n"),

  // Just body_hash + ts + nonce
  "F4_bodyHash_ts_nonce": (e) =>
    ["POST","/v1/chat/completions", sha256(e.body), e.headers["x-atomcode-ts"], e.headers["x-atomcode-nonce"]].join("\n"),

  // Raw body (no hash) with token
  "F5_rawBody_token_ts_nonce": (e) =>
    ["POST","/v1/chat/completions", e.body, oauthToken, e.headers["x-atomcode-ts"], e.headers["x-atomcode-nonce"]].join("\n"),

  // Raw body only
  "F6_rawBody_ts_nonce": (e) =>
    ["POST","/v1/chat/completions", e.body, e.headers["x-atomcode-ts"], e.headers["x-atomcode-nonce"]].join("\n"),

  // With ver
  "F7_bodyHash_token_userId_ts_nonce_ver": (e) =>
    ["POST","/v1/chat/completions", sha256(e.body), oauthToken, userId, e.headers["x-atomcode-ts"], e.headers["x-atomcode-nonce"], e.headers["x-atomcode-ver"]].join("\n"),

  // With alg
  "F8_bodyHash_token_ts_nonce_alg": (e) =>
    ["POST","/v1/chat/completions", sha256(e.body), oauthToken, e.headers["x-atomcode-ts"], e.headers["x-atomcode-nonce"], e.headers["x-atomcode-alg"]].join("\n"),

  // Minimal: just path + bodyHash + ts + nonce
  "F9_bodyHash_ts_nonce": (e) =>
    [sha256(e.body), e.headers["x-atomcode-ts"], e.headers["x-atomcode-nonce"]].join("\n"),

  // Body hash prepended to body
  "F10_bodyHash_body_ts_nonce": (e) =>
    ["POST","/v1/chat/completions", sha256(e.body) + "\n" + e.body, e.headers["x-atomcode-ts"], e.headers["x-atomcode-nonce"]].join("\n"),
};

// All key derivations
type KeyFn = () => Buffer;

const token = oauthToken;
const keyFns: Record<string, KeyFn> = {
  // Raw token variations
  "K1_token_raw":       () => Buffer.from(token),
  "K2_token_upper":     () => Buffer.from(token.toUpperCase()),
  "K3_token_lower":     () => Buffer.from(token.toLowerCase()),
  
  // SHA256 derivations
  "K4_sha256_token":    () => crypto.createHash("sha256").update(token).digest(),
  "K5_sha256_ut":       () => crypto.createHash("sha256").update(userId + token).digest(),
  "K6_sha256_tu":       () => crypto.createHash("sha256").update(token + userId).digest(),
  "K7_sha256_td":       () => crypto.createHash("sha256").update(token + deviceId).digest(),
  "K8_sha256_udt":      () => crypto.createHash("sha256").update(userId + deviceId + token).digest(),
  
  // HMAC derivations (single step)
  "K9_hmac_ac_token":   () => crypto.createHmac("sha256", "atomcode").update(token).digest(),
  "K10_hmac_ag_token":  () => crypto.createHmac("sha256", "atomgit").update(token).digest(),
  "K11_hmac_cp_token":  () => crypto.createHmac("sha256", "codingplan").update(token).digest(),
  "K12_hmac_ccp_token": () => crypto.createHmac("sha256", "atomcode-codingplan-v1").update(token).digest(),
  "K13_hmac_uid_token": () => crypto.createHmac("sha256", userId).update(token).digest(),
  "K14_hmac_did_token": () => crypto.createHmac("sha256", deviceId).update(token).digest(),
  
  // CoffeeCat138: double HMAC
  "K15_cc_double": () => {
    const i = crypto.createHmac("sha256", "atomcode-codingplan-v1").update(token).digest();
    return crypto.createHmac("sha256", i).update("signing-key-derivation").digest();
  },
  
  // Double HMAC with different second step
  "K16_acp_double": () => {
    const i = crypto.createHmac("sha256", "atomcode-codingplan-v1").update(token).digest();
    return crypto.createHmac("sha256", i).update("atomcode").digest();
  },
  "K17_acp_v1": () => {
    const i = crypto.createHmac("sha256", "atomcode-codingplan-v1").update(token).digest();
    return crypto.createHmac("sha256", i).update("v1").digest();
  },
  
  // Triple HMAC
  "K18_triple": () => {
    const i1 = crypto.createHmac("sha256", "atomcode-codingplan-v1").update(token).digest();
    const i2 = crypto.createHmac("sha256", i1).update("signing-key-derivation").digest();
    return crypto.createHmac("sha256", i2).update("v1").digest();
  },

  // Device-based
  "K19_hmac_did_acp_token": () => {
    const i = crypto.createHmac("sha256", deviceId).update("atomcode-codingplan-v1"+token).digest();
    return i;
  },
};

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

// Test all combinations
for (const [fmtName, fmtFn] of Object.entries(formats)) {
  for (const [keyName, keyFn] of Object.entries(keyFns)) {
    let matches = 0;
    for (const entry of entries.slice(0, 5)) {
      const msg = fmtFn(entry);
      const key = keyFn();
      const sig = crypto.createHmac("sha256", key).update(msg).digest("hex");
      const computed = "v1:" + sig;
      if (computed === entry.headers["x-atomcode-sig"]) {
        matches++;
      } else {
        break;
      }
    }
    if (matches >= 3) {
      console.log(`🎯 MATCH! ${matches}/5  fmt=${fmtName}  key=${keyName}`);
    }
  }
}

// Also try: the nonce might be raw bytes (not hex) in the message
console.log("\n--- Trying raw nonce bytes ---");
for (const [fmtName, fmtFn] of Object.entries(formats)) {
  for (const [keyName, keyFn] of Object.entries(keyFns)) {
    let matches = 0;
    for (const entry of entries.slice(0, 3)) {
      // Replace hex nonce with raw bytes
      let msg = fmtFn(entry);
      const nonceRaw = Buffer.from(entry.headers["x-atomcode-nonce"], "hex");
      msg = msg.replace(entry.headers["x-atomcode-nonce"], nonceRaw.toString("binary"));
      const key = keyFn();
      const sig = crypto.createHmac("sha256", key).update(msg, "binary").digest("hex");
      if ("v1:" + sig === entry.headers["x-atomcode-sig"]) matches++;
      else break;
    }
    if (matches >= 2) {
      console.log(`🎯 MATCH (raw nonce)! ${matches}/3  fmt=${fmtName}  key=${keyName}`);
    }
  }
}

console.log("\nDone.");
