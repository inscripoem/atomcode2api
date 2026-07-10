// Quick verify: test the signing algorithm from CoffeeCat138/Atomcode-proxy
// against our captured signatures.
import * as crypto from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = ".";
const files = readdirSync(dir).filter(f => f.startsWith("capture-http-") && f.endsWith(".json"));
const entries = files.map(f => JSON.parse(readFileSync(join(dir, f), "utf-8"))).slice(0, 5);

const oauthToken = entries[0].headers["authorization"].replace("Bearer ", "").trim();
const userId = "6918f6575c308f65ad20a999";

// Key derivation from CoffeeCat138's signing.ts:
// intermediate = HMAC-SHA256("atomcode-codingplan-v1", oauth_token)
// signingKey = HMAC-SHA256(intermediate, "signing-key-derivation")
const intermediate = crypto.createHmac("sha256", "atomcode-codingplan-v1").update(oauthToken).digest();
const signingKey = crypto.createHmac("sha256", intermediate).update("signing-key-derivation").digest();

console.log(`Token: ${oauthToken}`);
console.log(`Key len: ${signingKey.length} bytes\n`);

let matched = 0;
for (const entry of entries) {
  const ts = entry.headers["x-atomcode-ts"];
  const nonceHex = entry.headers["x-atomcode-nonce"];
  const capturedSig = entry.headers["x-atomcode-sig"];

  // Canonical message: METHOD\nPATH\nBODY_HASH\nTOKEN\nUSER_ID\nTS\nNONCE
  const bodyHash = crypto.createHash("sha256").update(entry.body).digest("hex");
  const msg = ["POST", "/v1/chat/completions", bodyHash, oauthToken, userId, ts, nonceHex].join("\n");

  const sig = crypto.createHmac("sha256", signingKey).update(msg).digest("hex");
  const computed = "v1:" + sig;

  if (computed === capturedSig) {
    matched++;
  }
  console.log(computed === capturedSig ? "MATCH" : "MISMATCH",
    ` | nonce=${nonceHex.slice(0,12)}... ts=${ts}`);
}
console.log(`\n${matched}/${entries.length} matched`);

// Also try without "signing-key-derivation" step
console.log("\n--- Trying WITHOUT second HMAC step ---");
const key2 = crypto.createHmac("sha256", "atomcode-codingplan-v1").update(oauthToken).digest();
matched = 0;
for (const entry of entries) {
  const ts = entry.headers["x-atomcode-ts"];
  const nonceHex = entry.headers["x-atomcode-nonce"];
  const capturedSig = entry.headers["x-atomcode-sig"];
  const bodyHash = crypto.createHash("sha256").update(entry.body).digest("hex");
  const msg = ["POST", "/v1/chat/completions", bodyHash, oauthToken, userId, ts, nonceHex].join("\n");
  const sig = crypto.createHmac("sha256", key2).update(msg).digest("hex");
  const computed = "v1:" + sig;
  if (computed === capturedSig) matched++;
  console.log(computed === capturedSig ? "MATCH" : "MISMATCH");
}
console.log(`${matched}/${entries.length} matched`);
