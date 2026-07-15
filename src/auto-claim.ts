// src/auto-claim.ts
// Usage: bun run src/auto-claim.ts
// Set CODINGPLAN_TOKEN env var or have auth.toml/auth.json available
import proxyFetch from "./fetch-proxy";

const UPSTREAM = "https://api.gitcode.com/api/v5";
const UA = "atomcode/4.26.0";
const BJT_OFFSET = 8 * 3600 * 1000; // UTC+8

function nowBJT(): Date {
  return new Date(Date.now() + BJT_OFFSET);
}

function loadToken(): string {
  // Check env
  if (process.env.CODINGPLAN_TOKEN) return process.env.CODINGPLAN_TOKEN;

  // Check atomcode2api auth.json
  try {
    const { readFileSync } = require("node:fs");
    const { homedir } = require("node:os");
    const { join } = require("node:path");
    const authPath = join(homedir(), ".atomcode2api", "auth.json");
    const auth = JSON.parse(readFileSync(authPath, "utf-8"));
    if (auth.access_token) return auth.access_token;
  } catch {}

  // Check atomcode auth.toml
  try {
    const { readFileSync } = require("node:fs");
    const { homedir } = require("node:os");
    const { join } = require("node:path");
    const authPath = join(homedir(), ".atomcode", "auth.toml");
    const content = readFileSync(authPath, "utf-8");
    for (const line of content.split("\n")) {
      if (line.trim().startsWith("access_token")) {
        return line.split("=", 1)[1].trim().replace(/^"|"$/g, "");
      }
    }
  } catch {}

  return "";
}

async function claim(token: string): Promise<any> {
  const resp = await proxyFetch(`${UPSTREAM}/coding-plan/claim-v2`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent": UA,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ plan_type: "Pro" }),
  });
  return resp.json();
}

function log(msg: string) {
  const ts = nowBJT().toISOString().slice(11, 23);
  console.log(`[${ts}] ${msg}`);
}

async function waitUntil(hour: number, minute: number, second: number, ms: number) {
  while (true) {
    const now = nowBJT();
    const target = new Date(now);
    target.setUTCHours(hour - 8, minute, second, ms); // convert BJT to UTC
    if (now >= target) {
      target.setUTCDate(target.getUTCDate() + 1);
    }
    const wait = target.getTime() - Date.now();
    if (wait <= 2000) {
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      return;
    }
    log(`Target: ${target.toISOString().slice(0, 23)} BJT, waiting ${(wait / 1000).toFixed(0)}s`);
    await new Promise(r => setTimeout(r, wait - 2000));
  }
}

async function main() {
  const token = loadToken();
  if (!token) {
    console.error("No token found. Set CODINGPLAN_TOKEN or run login first.");
    process.exit(1);
  }
  log("Daily Pro claimer started");

  while (true) {
    await waitUntil(9, 59, 59, 800);
    const end = new Date(nowBJT());
    end.setUTCHours(10 - 8, 0, 59, 800);
    log("Starting Pro claim window");

    let attempt = 0;
    while (Date.now() <= end.getTime()) {
      attempt++;
      try {
        const result = await claim(token);
        const msg = result.message || JSON.stringify(result);
        log(`[${attempt}] ${msg}`);
        if (result.success) {
          log("Pro claimed successfully!");
          return;
        }
      } catch (e: any) {
        log(`[${attempt}] error: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 200));
    }
    log("Window ended, waiting for next day");
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});