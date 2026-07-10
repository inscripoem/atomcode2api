// src/crack-sign-v2.ts
// Enhanced brute-force: try many more canonical message formats and key derivations.
// Leverages 12 captures with same body, different nonce/ts.
import * as crypto from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

interface CaptureEntry {
  headers: Record<string, string>;
  body: string;
}

function loadCaptures(dir: string): CaptureEntry[] {
  const files = readdirSync(dir).filter(f => f.startsWith("capture-http-") && f.endsWith(".json"));
  return files.map(f => JSON.parse(readFileSync(join(dir, f), "utf-8")));
}

// Build canonical message bytes
function buildMessage(
  format: string,
  method: string, path: string, body: string,
  ts: string, nonceHex: string, ver: string, alg: string, userId: string
): Buffer {
  const nonceRaw = Buffer.from(nonceHex, "hex");

  switch (format) {
    // ─── Raw nonce prepended ───
    case "r1": return Buffer.concat([nonceRaw, Buffer.from(`${method}\n${path}\n${ts}\n${body}`)]);
    case "r2": return Buffer.concat([nonceRaw, Buffer.from(`${method}\n${path}\n${ts}\n${ver}\n${body}`)]);
    case "r3": return Buffer.concat([nonceRaw, Buffer.from(`${ts}\n${nonceHex}\n${method}\n${path}\n${body}`)]);
    case "r4": return Buffer.concat([nonceRaw, Buffer.from(`${method}\n${path}\n${body}`), Buffer.from(ts), nonceRaw]);

    // ─── Raw nonce appended ───
    case "r5": return Buffer.concat([Buffer.from(`${method}\n${path}\n${ts}\n${body}`), nonceRaw]);
    case "r6": return Buffer.concat([Buffer.from(`${method}\n${path}\n${ts}\n${body}\n${ver}`), nonceRaw]);

    // ─── ts as big-endian u64 bytes ───
    case "b1": {
      const tsBuf = Buffer.alloc(8); tsBuf.writeBigUInt64BE(BigInt(ts)); 
      return Buffer.concat([nonceRaw, tsBuf, Buffer.from(`${method}\n${path}\n${body}`)]);
    }
    case "b2": {
      const tsBuf = Buffer.alloc(8); tsBuf.writeBigUInt64BE(BigInt(ts));
      return Buffer.concat([Buffer.from(`${method}\n${path}\n`), tsBuf, nonceRaw, Buffer.from(`\n${body}`)]);
    }
    case "b3": {
      // nonce(16) + ts(8) + body_len(4) + body
      const tsBuf = Buffer.alloc(8); tsBuf.writeBigUInt64BE(BigInt(ts));
      const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(Buffer.byteLength(body));
      return Buffer.concat([nonceRaw, tsBuf, lenBuf, Buffer.from(body)]);
    }
    case "b4": {
      // method(4 bytes len) + path(4 bytes len) + body(4 bytes) + ts(8) + nonce(16)
      const m = Buffer.from(method); const p = Buffer.from(path); const b = Buffer.from(body);
      const tsBuf = Buffer.alloc(8); tsBuf.writeBigUInt64BE(BigInt(ts));
      const parts: Buffer[] = [];
      for (const buf of [m, p, b]) {
        const lb = Buffer.alloc(4); lb.writeUInt32BE(buf.length); parts.push(lb, buf);
      }
      parts.push(tsBuf, nonceRaw);
      return Buffer.concat(parts);
    }

    // ─── More line-based ───
    case "l1": return Buffer.from(`${method}\n${path}\n${body}\n${ts}\n${nonceHex}\n${userId}\n${ver}`);
    case "l2": return Buffer.from(`${method}\n${path}\n${body}\n${ts}\n${nonceHex}\n${ver}\n${alg}`);
    case "l3": return Buffer.from(`${nonceHex}\n${ts}\n${method}\n${path}\n${body}\n${ver}`);
    case "l4": return Buffer.from(`${method}\n${path}\n${ts}\n${nonceHex}\n${ver}\n${alg}\n${userId}\n${body}`);
    case "l5": return Buffer.from(`${method}\n${path}\n${ts}\n${nonceHex}\n${userId}\n${ver}\n${alg}\n${body}`);
    case "l6": return Buffer.from(`${ts}\n${nonceHex}\n${method}\n${path}\n${userId}\n${ver}\n${body}`);

    // ─── Colon/double-newline ───
    case "c1": return Buffer.from(`${method}:${path}:${ts}:${nonceHex}:${body}`);
    case "c2": return Buffer.from(`${ts}:${nonceHex}:${method}:${path}:${ver}:${body}`);

    // ─── Body-only signing (sign the body hash, not body) ───
    case "h1": {
      const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
      return Buffer.from(`${method}\n${path}\n${ts}\n${nonceHex}\n${bodyHash}`);
    }
    case "h2": {
      const bodyHash = crypto.createHash("sha256").update(body).digest();
      return Buffer.concat([Buffer.from(`${method}\n${path}\n${ts}\n`), nonceRaw, Buffer.from(`\n`), bodyHash]);
    }

    default: return Buffer.from("");
  }
}

function tryFormat(
  format: string, keyType: string,
  entry: CaptureEntry, oauthToken: string, userId: string
): { match: boolean; computed: string; expected: string } {
  const ts = entry.headers["x-atomcode-ts"];
  const nonceHex = entry.headers["x-atomcode-nonce"];
  const ver = entry.headers["x-atomcode-ver"] || "4.26.0";
  const alg = entry.headers["x-atomcode-alg"] || "1";
  const capturedSig = entry.headers["x-atomcode-sig"]; // "v1:64hex"

  const message = buildMessage(format, "POST", "/v1/chat/completions", entry.body, ts, nonceHex, ver, alg, userId);

  // Derive key
  let key: Buffer;
  switch (keyType) {
    case "token_utf8":     key = Buffer.from(oauthToken, "utf-8"); break;
    case "token_hex":      key = Buffer.from(Buffer.from(oauthToken, "utf-8").toString("hex")); break;
    case "token_reverse":  key = Buffer.from(oauthToken.split("").reverse().join("")); break;
    case "sha256_token":   key = crypto.createHash("sha256").update(oauthToken).digest(); break;
    case "sha256_user_token": key = crypto.createHash("sha256").update(userId + ":" + oauthToken).digest(); break;
    case "sha256_token_upper": key = crypto.createHash("sha256").update(oauthToken.toUpperCase()).digest(); break;
    case "sha256_token_lower": key = crypto.createHash("sha256").update(oauthToken.toLowerCase()).digest(); break;
    case "hmac_app_token": key = crypto.createHmac("sha256", "atomcode").update(oauthToken).digest(); break;
    case "hmac_app_user_token": key = crypto.createHmac("sha256", "AtomCode").update(userId + oauthToken).digest(); break;
    case "hmac_gitcode_token": key = crypto.createHmac("sha256", "atomgit").update(oauthToken).digest(); break;
    case "hmac_codingplan_token": key = crypto.createHmac("sha256", "codingplan").update(oauthToken).digest(); break;
    case "hmac_llmapi_token": key = crypto.createHmac("sha256", "llm-api").update(oauthToken).digest(); break;
    case "hmac_ver_token": key = crypto.createHmac("sha256", ver).update(oauthToken).digest(); break;
    case "hmac_user_ver_token": key = crypto.createHmac("sha256", userId).update(ver + oauthToken).digest(); break;
    case "hkdf_sha256":    key = crypto.hkdfSync("sha256", oauthToken, "", userId + ver, 32); break;
    case "pbkdf2_token":   key = crypto.pbkdf2Sync(oauthToken, userId, 1, 32, "sha256"); break;
    case "pbkdf2_reverse": key = crypto.pbkdf2Sync(userId, oauthToken, 1, 32, "sha256"); break;
    case "hmac_token_token": key = crypto.createHmac("sha256", oauthToken).update(oauthToken).digest(); break;
    case "hmac_user_token": key = crypto.createHmac("sha256", userId).update(oauthToken).digest(); break;
    default: return { match: false, computed: "", expected: capturedSig };
  }

  const hmac = crypto.createHmac("sha256", key);
  hmac.update(message);
  const computed = "v1:" + hmac.digest("hex");
  return { match: computed === capturedSig, computed, expected: capturedSig };
}

// ── Main ──
async function main() {
  const captureDir = process.argv[2] || ".";
  const userId = process.argv[3] || "";

  const entries = loadCaptures(captureDir);
  if (entries.length < 3) {
    console.error(`Need >=3 captures. Found ${entries.length}.`);
    process.exit(1);
  }

  const authHeader = entries[0].headers["authorization"];
  if (!authHeader) { console.error("No auth header"); process.exit(1); }
  const oauthToken = authHeader.replace("Bearer ", "").trim();

  console.log(`Captures: ${entries.length}, Token len: ${oauthToken.length}, Body len: ${entries[0].body.length}`);
  console.log(`User ID: ${userId}\n`);

  const formats = ["r1","r2","r3","r4","r5","r6","b1","b2","b3","b4","l1","l2","l3","l4","l5","l6","c1","c2","h1","h2"];
  const keyTypes = [
    "token_utf8","token_hex","token_reverse",
    "sha256_token","sha256_user_token","sha256_token_upper","sha256_token_lower",
    "hmac_app_token","hmac_app_user_token","hmac_gitcode_token","hmac_codingplan_token",
    "hmac_llmapi_token","hmac_ver_token","hmac_user_ver_token",
    "hkdf_sha256","pbkdf2_token","pbkdf2_reverse",
    "hmac_token_token","hmac_user_token",
  ];

  const testEntries = entries.slice(0, 5); // test against first 5
  let results: { format: string; keyType: string; matches: number; entry0Computed: string }[] = [];

  for (const fmt of formats) {
    for (const kt of keyTypes) {
      let matches = 0;
      for (const entry of testEntries) {
        const result = tryFormat(fmt, kt, entry, oauthToken, userId);
        if (result.match) matches++;
        else break;
      }
      if (matches >= 3) {
        results.push({ format: fmt, keyType: kt, matches, entry0Computed: tryFormat(fmt, kt, testEntries[0], oauthToken, userId).computed });
      }
    }
  }

  if (results.length > 0) {
    results.sort((a, b) => b.matches - a.matches);
    for (const r of results) {
      console.log(`🎯 MATCH! ${r.matches}/${testEntries.length}  format=${r.format}  key=${r.keyType}`);
      console.log(`   sig: ${r.entry0Computed}`);
    }
  } else {
    console.log("❌ No match with ${formats.length * keyTypes.length} combinations.");
    console.log("\nTrying ALL entries (not just first 5) with best partial matches...");

    // Show best partial matches (matches on some entries)
    let partials: { format: string; keyType: string; matches: number }[] = [];
    for (const fmt of formats) {
      for (const kt of keyTypes) {
        let matches = 0;
        for (const entry of entries) {
          if (tryFormat(fmt, kt, entry, oauthToken, userId).match) matches++;
        }
        if (matches >= 1) partials.push({ format: fmt, keyType: kt, matches });
      }
    }
    partials.sort((a, b) => b.matches - a.matches);
    for (const p of partials.slice(0, 10)) {
      console.log(`  partial: ${p.matches}/${entries.length}  format=${p.format}  key=${p.keyType}`);
    }
    if (partials.length === 0) {
      console.log("  (no partial matches either)");
    }
  }
}

main().catch(console.error);
