// src/token-store.ts
// Persists auth tokens to disk and provides thread-safe access with auto-refresh.

import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { platform } from "node:os";
import { join } from "node:path";

const CONFIG_DIR = join(import.meta.dirname, "..", "data");
const AUTH_FILE = join(CONFIG_DIR, "auth.json");
const REFRESH_MARGIN_SEC = 300;

export interface UserInfo {
  id: string;
  username: string;
  name?: string;
  email?: string;
  avatar_url?: string;
}

export interface AuthData {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
  created_at: number; // unix seconds
  user: UserInfo;
}

let cachedAuth: AuthData | null = null;
let refreshPromise: Promise<AuthData | null> | null = null;

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    if (platform() !== "win32") {
      // chmod 700 on Unix
      try { import("node:fs").then(fs => fs.chmodSync(CONFIG_DIR, 0o700)); } catch {}
    }
  }
}

export function loadAuth(): AuthData | null {
  if (cachedAuth) return cachedAuth;
  if (!existsSync(AUTH_FILE)) return null;
  try {
    const raw = readFileSync(AUTH_FILE, "utf-8");
    cachedAuth = JSON.parse(raw) as AuthData;
    return cachedAuth;
  } catch {
    return null;
  }
}

export function saveAuth(auth: AuthData): void {
  ensureConfigDir();
  cachedAuth = auth;
  writeFileSync(AUTH_FILE, JSON.stringify(auth, null, 2), { encoding: "utf-8", mode: platform() !== "win32" ? 0o600 : undefined });
}

export function clearAuth(): void {
  cachedAuth = null;
  if (existsSync(AUTH_FILE)) {
    try { unlinkSync(AUTH_FILE); } catch {}
  }
}

export function isTokenExpired(auth: AuthData): boolean {
  if (!auth.expires_in) return false;
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = auth.created_at + auth.expires_in;
  return now >= expiresAt - REFRESH_MARGIN_SEC;
}

export function isLoggedIn(): boolean {
  return loadAuth() !== null;
}

export async function getValidToken(): Promise<string> {
  const auth = loadAuth();
  if (!auth) throw new Error("Not logged in. Please visit /login first.");

  if (!isTokenExpired(auth)) {
    return auth.access_token;
  }

  // Token expired or about to expire — try refresh
  if (refreshPromise) {
    const result = await refreshPromise;
    if (!result) throw new Error("Token refresh failed.");
    return result.access_token;
  }

  refreshPromise = doRefreshToken(auth);
  try {
    const result = await refreshPromise;
    if (!result) throw new Error("Token refresh failed — please re-login.");
    return result.access_token;
  } finally {
    refreshPromise = null;
  }
}

async function doRefreshToken(auth: AuthData): Promise<AuthData | null> {
  if (!auth.refresh_token) return null;

  const platformServer = process.env.ATOMCODE_PLATFORM_SERVER || "https://acs.atomgit.com";
  const refreshUrl = `${platformServer}/oauth/refresh`;

  try {
    const resp = await fetch(refreshUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "atomcode/4.26.0" },
      body: JSON.stringify({ refresh_token: auth.refresh_token }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) return null;

    const body = await resp.json() as {
      access_token: string;
      token_type?: string;
      expires_in?: number;
      refresh_token?: string;
      user?: UserInfo;
    };

    const newAuth: AuthData = {
      access_token: body.access_token,
      refresh_token: body.refresh_token ?? auth.refresh_token,
      token_type: body.token_type ?? auth.token_type,
      expires_in: body.expires_in ?? auth.expires_in,
      created_at: Math.floor(Date.now() / 1000),
      user: body.user ?? auth.user,
    };

    saveAuth(newAuth);
    return newAuth;
  } catch {
    return null;
  }
}
