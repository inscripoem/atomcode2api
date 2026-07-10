// src/crack-sign.ts
// Brute-force reverse-engineer the HMAC-SHA256 signing canonical message format
// and key derivation. We have multiple captured signatures with the same body,
// different nonces and timestamps. Try common formats until one matches.

// In Bun, we need subtle crypto for HMAC
const crypto = require("node:crypto");

interface CaptureEntry {
  headers: Record<string, string>;
  body: string;
  timestamp: string;
}

async function loadCaptures(dir: string): Promise<CaptureEntry[]> {
  const files = new Bun.Glob("capture-http-*.json").scanSync({ cwd: dir, absolute: true });
  const entries: CaptureEntry[] = [];
  for (const f of files) {
    try {
      const raw = await Bun.file(f).text();
      entries.push(JSON.parse(raw));
    } catch {}
  }
  return entries;
}

// Try a canonical message format and key, check if HMAC matches
function tryFormat(
  format: string,
  entry: CaptureEntry,
  oauthToken: string,
  userId: string,
  extraKeyMaterial?: string
): { match: boolean; computed: string; expected: string } {
  const method = "POST";
  const path = "/v1/chat/completions";
  const body = entry.body;
  const ts = entry.headers["x-atomcode-ts"];
  const nonceHex = entry.headers["x-atomcode-nonce"]; // 32-char hex
  const nonceRaw = Buffer.from(nonceHex, "hex"); // 16 bytes
  const ver = entry.headers["x-atomcode-ver"] || "4.26.0";
  const alg = entry.headers["x-atomcode-alg"] || "1";
  const capturedSig = entry.headers["x-atomcode-sig"]; // "v1:64-hex"

  // Build canonical message according to format spec
  let message: string;
  switch (format) {
    // ─── Line-based formats (most common for HMAC signing) ───
    case "L1": // method\npath\nts\nnonce_hex\nbody
      message = `${method}\n${path}\n${ts}\n${nonceHex}\n${body}`;
      break;
    case "L2": // method\npath\nts\nnonce_hex\nbody\nver
      message = `${method}\n${path}\n${ts}\n${nonceHex}\n${body}\n${ver}`;
      break;
    case "L3": // method\npath\nts\nnonce_hex\nbody\nver\nalg
      message = `${method}\n${path}\n${ts}\n${nonceHex}\n${body}\n${ver}\n${alg}`;
      break;
    case "L4": // ts\nnonce_hex\nmethod\npath\nbody
      message = `${ts}\n${nonceHex}\n${method}\n${path}\n${body}`;
      break;
    case "L5": // nonce_hex\nts\nmethod\npath\nbody
      message = `${nonceHex}\n${ts}\n${method}\n${path}\n${body}`;
      break;
    case "L6": // method\npath\nbody\nts\nnonce_hex
      message = `${method}\n${path}\n${body}\n${ts}\n${nonceHex}`;
      break;
    case "L7": // method\npath\nbody\nts\nnonce_hex\nuser_id
      message = `${method}\n${path}\n${body}\n${ts}\n${nonceHex}\n${userId}`;
      break;
    case "L8": // method\npath\nbody\nts\nnonce_hex\nver\nalg
      message = `${method}\n${path}\n${body}\n${ts}\n${nonceHex}\n${ver}\n${alg}`;
      break;
    case "L9": // method\npath\nts\nnonce_hex\nver\nalg\nbody
      message = `${method}\n${path}\n${ts}\n${nonceHex}\n${ver}\n${alg}\n${body}`;
      break;
    case "L10": // method\npath\nts\nnonce_hex\nver\nbody
      message = `${method}\n${path}\n${ts}\n${nonceHex}\n${ver}\n${body}`;
      break;
    case "L11": // ts\nnonce_hex\nmethod\npath\nver\nbody
      message = `${ts}\n${nonceHex}\n${method}\n${path}\n${ver}\n${body}`;
      break;

    // ─── Raw-byte nonce formats (nonce as bytes prepended to message) ───
    case "R1": // nonce_raw + method\npath\nts\nbody (prepend raw nonce bytes)
      message = nonceRaw.toString("binary") + `${method}\n${path}\n${ts}\n${body}`;
      break;
    case "R2": // nonce_raw + method\npath\nts\nver\nbody
      message = nonceRaw.toString("binary") + `${method}\n${path}\n${ts}\n${ver}\n${body}`;
      break;
    case "R3": // nonce_raw + ts(ascii) + method\npath\nbody
      message = nonceRaw.toString("binary") + `${ts}\n${method}\n${path}\n${body}`;
      break;

    // ─── Delimiter-based formats ───
    case "D1": // method|path|ts|nonce_hex|body
      message = `${method}|${path}|${ts}|${nonceHex}|${body}`;
      break;
    case "D2": // method|path|ts|nonce_hex|ver|body
      message = `${method}|${path}|${ts}|${nonceHex}|${ver}|${body}`;
      break;

    // ─── JSON-like formats ───
    case "J1": // Canonical JSON: method+path+ts+nonce+body as structured
      message = `${method}${path}${ts}${nonceHex}${body}`;
      break;
    case "J2": // With ver
      message = `${method}${path}${ts}${nonceHex}${ver}${body}`;
      break;

    default:
      return { match: false, computed: "", expected: capturedSig };
  }

  // Try different keys
  const keys: { name: string; key: Buffer | string }[] = [
    { name: "token_raw", key: oauthToken },
    { name: "token_hex", key: Buffer.from(oauthToken, "utf-8").toString("hex") },
    { name: "token_utf8", key: Buffer.from(oauthToken, "utf-8") },
  ];

  // If extra key material provided, try derivations
  if (extraKeyMaterial) {
    keys.push(
      { name: "hkdf_sha256", key: crypto.createHmac("sha256", extraKeyMaterial).update(oauthToken).digest() },
      { name: "hmac_master_token", key: crypto.createHmac("sha256", extraKeyMaterial).update(oauthToken).digest("hex") },
    );
  }

  for (const k of keys) {
    const hmac = crypto.createHmac("sha256", k.key);
    hmac.update(message, "utf-8");
    const computed = "v1:" + hmac.digest("hex");

    if (computed === capturedSig) {
      return { match: true, computed, expected: capturedSig };
    }
  }

  // Also try HMAC-SHA256 with the key being the HMAC of token with various salts
  // This is for key derivation where master_secret is unknown
  return { match: false, computed: "", expected: capturedSig };
}

async function main() {
  const captureDir = process.argv[2] || ".";
  const userIdArg = process.argv[3] || ""; // user_id from auth.toml
  const entries = await loadCaptures(captureDir);

  if (entries.length < 2) {
    console.error("Need at least 2 capture files. Run http-capture first.");
    console.error(`Found ${entries.length} capture files in ${captureDir}`);
    process.exit(1);
  }

  console.log(`Loaded ${entries.length} capture entries\n`);

  // Extract oauth token from first entry
  const authHeader = entries[0].headers["authorization"];
  if (!authHeader) {
    console.error("No authorization header in capture");
    process.exit(1);
  }
  const oauthToken = authHeader.replace("Bearer ", "").trim();
  console.log(`OAuth token: ${oauthToken.slice(0, 30)}...`);
  console.log(`Token length: ${oauthToken.length}`);

  // Extract content length and body
  const body = entries[0].body;
  console.log(`Body length: ${body.length}`);

  // User ID — try to extract from token or use a placeholder
  // The user_id is in the auth.toml, but we don't have it easily
  // Let's try without it first, and also try with it
  const userId = userIdArg;
  console.log(`User ID: ${userId || "(not provided)"}`);

  // All format variants to try
  const formats = [
    "L1","L2","L3","L4","L5","L6","L7","L8","L9","L10","L11",
    "R1","R2","R3",
    "D1","D2",
    "J1","J2",
  ];

  let found = false;

  // Try each format against all entries
  for (const format of formats) {
    let allMatch = true;
    let matches = 0;

    for (const entry of entries.slice(0, 5)) { // Test first 5 entries
      const result = tryFormat(format, entry, oauthToken, userId);
      if (result.match) {
        matches++;
      } else {
        allMatch = false;
        break;
      }
    }

    if (allMatch && matches >= 2) {
      console.log(`\n🎯 MATCH! Format: ${format}`);
      console.log(`   Verified against ${matches} captures`);

      // Show the canonical message for the first entry
      const entry = entries[0];
      const ts = entry.headers["x-atomcode-ts"];
      const nonceHex = entry.headers["x-atomcode-nonce"];
      console.log(`   Method: POST, Path: /v1/chat/completions`);
      console.log(`   TS: ${ts}, Nonce: ${nonceHex}`);
      found = true;
      break;
    }
  }

  if (!found) {
    console.log("\n❌ No exact match found with basic key derivations.");
    console.log("   The HMAC key is likely derived, not the raw token.");
    console.log("   Need to try:");
    console.log("   - Different canonical message formats (binary prepend, etc.)");
    console.log("   - Key = HMAC(token, master_secret) with unknown master_secret");
    console.log("   - Key = HMAC(user_id + token, unknown_master)");
    console.log("");
    console.log("   Next: try with user_id from auth.toml, and more formats.");
  }
}

main().catch(console.error);
