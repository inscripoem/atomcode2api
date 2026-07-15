// src/auth.ts
// OAuth login flow against AtomGit platform broker.

import { saveAuth, AuthData } from "./token-store";
import proxyFetch from "./fetch-proxy";

interface LoginStartResponse {
  login_url: string;
  state: string;
}

interface CheckResponse {
  valid: boolean;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  user: {
    id: string;
    username: string;
    name?: string;
    email?: string;
    avatar_url?: string;
  };
}

function platformBase(): string {
  return (process.env.ATOMCODE_PLATFORM_SERVER || "https://acs.atomgit.com").replace(/\/+$/, "");
}

/**
 * Start OAuth login — calls /auth/login?provider=atomgit
 * Returns a login URL the user must visit + a state token for polling.
 */
export async function startLogin(): Promise<LoginStartResponse> {
  const url = `${platformBase()}/auth/login?provider=atomgit`;
  const resp = await proxyFetch(url, {
    method: "GET",
    headers: { "User-Agent": "atomcode/4.26.0" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) {
    throw new Error(`Login start failed: ${resp.status} ${await resp.text()}`);
  }
  return resp.json() as Promise<LoginStartResponse>;
}

/**
 * Poll /auth/check — returns true once user has authorized in the browser.
 */
export async function pollLogin(state: string): Promise<boolean> {
  const url = `${platformBase()}/auth/check?state=${encodeURIComponent(state)}`;
  const resp = await proxyFetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: { "User-Agent": "atomcode/4.26.0" },
  });
  if (!resp.ok) return false;
  try {
    const body = (await resp.json()) as CheckResponse;
    return body.valid === true;
  } catch {
    return false;
  }
}

/**
 * Exchange state for token — final step of OAuth.
 */
export async function exchangeToken(state: string): Promise<AuthData> {
  const url = `${platformBase()}/auth/token?state=${encodeURIComponent(state)}`;
  const resp = await proxyFetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers: { "User-Agent": "atomcode/4.26.0" },
  });
  if (!resp.ok) {
    throw new Error(`Token exchange failed: ${resp.status} ${await resp.text()}`);
  }
  const body = (await resp.json()) as TokenResponse;

  const auth: AuthData = {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    token_type: body.token_type,
    expires_in: body.expires_in,
    created_at: Math.floor(Date.now() / 1000),
    user: {
      id: body.user.id,
      username: body.user.username,
      name: body.user.name,
      email: body.user.email,
      avatar_url: body.user.avatar_url,
    },
  };

  saveAuth(auth);
  return auth;
}
