// src/fetch-proxy.ts
// Wraps global fetch with HTTP proxy support for Bun.
// Bun does NOT respect HTTP_PROXY env — we inject it via the `proxy` option.

const PROXY_URL = process.env.HTTP_PROXY || process.env.HTTPS_PROXY || "";

/**
 * Fetch wrapper that routes through HTTP_PROXY / HTTPS_PROXY when set.
 * Falls back to direct connection when no proxy is configured.
 */
export async function proxyFetch(
  url: string | URL | Request,
  init?: RequestInit,
): Promise<Response> {
  if (!PROXY_URL) return fetch(url, init);
  // Bun supports a `proxy` option on fetch options (undocumented but works)
  return fetch(url, { ...init, proxy: PROXY_URL } as RequestInit);
}

export default proxyFetch;
