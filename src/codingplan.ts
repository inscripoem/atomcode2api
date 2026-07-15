// src/codingplan.ts
// CodingPlan API client — claim plans, list models, get status.

import { getValidToken } from "./token-store";

const DEFAULT_API_BASE = "https://api.gitcode.com/api/v5";

function apiBase(): string {
  return (process.env.ATOMCODE_CODINGPLAN_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");
}

export interface ModelEntry {
  id: number;
  is_infinity: number;
  is_atomcode_exclusive: number;
  display_model_name: string;
  base_url?: string;
  type?: string;
  context_window?: number;
  plan_available: boolean;
  capable_model?: number;
}

export interface ClaimResponse {
  success: boolean;
  duplicate: boolean;
  message: string;
  plan_name?: string;
}

export interface StatusResponse {
  codingplan_free?: {
    plan_name: string;
    status: number;
    claimed_at: string;
    expires_at: string;
    remaining_days: number;
    total_days: number;
  } | null;
  current_usage?: any;
  audit_status: number;
  expires_at?: string;
  window_quota_exhausted: boolean;
  window_quota_hint?: string;
  rate_limit_windows?: Array<{
    show_enable: number;
    window_hours: number;
    call_limit: number;
    calls_used: number;
    usage_percent: number;
    quota_exhausted: boolean;
    reset_at_display: string;
    seconds_until_reset: number;
    usage_status_desc: string;
  }>;
}

const COMMON_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "atomcode2api/1.0",
};

/**
 * Sanitize upstream error body: detect HTML/gateway responses and
 * return a clean message instead of raw markup.
 */
function formatUpstreamError(endpoint: string, status: number, body: string): string {
  const trimmed = body.trimStart();
  const isHtml = trimmed.startsWith("<") || trimmed.startsWith("<!DOCTYPE");
  if (isHtml) {
    return `${endpoint} returned ${status} (HTML — likely gateway/block, check server IP)`;
  }
  return `${endpoint} returned ${status}: ${trimmed.slice(0, 200)}`;
}

/**
 * Claim a CodingPlan tier (Max → Pro → Lite cascade).
 */
export async function claimPlan(planType: string): Promise<ClaimResponse> {
  const token = await getValidToken();
  const url = `${apiBase()}/coding-plan/claim-v2`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { ...COMMON_HEADERS, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ plan_type: planType }),
    signal: AbortSignal.timeout(10_000),
  });

  if (resp.status === 401 || resp.status === 403) {
    throw new Error(`authentication failed (${resp.status}) — please re-login`);
  }
  if (!resp.ok) {
    const body = await resp.text();
    try {
      const err = JSON.parse(body);
      if (err.message) throw new Error(err.message);
    } catch (e) {
      if (!(e instanceof SyntaxError) && e instanceof Error) throw e;
    }
    throw new Error(formatUpstreamError("claim-v2", resp.status, body));
  }

  return resp.json() as Promise<ClaimResponse>;
}

/**
 * List available models for a CodingPlan tier.
 */
export async function listModels(planType: string = "Max"): Promise<ModelEntry[]> {
  const token = await getValidToken();
  const url = `${apiBase()}/coding-plan/models-v2?plan_type=${encodeURIComponent(planType)}`;

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": COMMON_HEADERS["User-Agent"] },
    signal: AbortSignal.timeout(10_000),
  });

  if (resp.status === 401 || resp.status === 403) {
    throw new Error(`authentication failed (${resp.status}) — please re-login`);
  }
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(formatUpstreamError("models-v2", resp.status, body));
  }

  return resp.json() as Promise<ModelEntry[]>;
}

/**
 * Get CodingPlan status/quota.
 */
export async function getStatus(): Promise<StatusResponse> {
  const token = await getValidToken();
  const url = `${apiBase()}/coding-plan/status-v2`;

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": COMMON_HEADERS["User-Agent"] },
    signal: AbortSignal.timeout(10_000),
  });

  if (resp.status === 401 || resp.status === 403) {
    throw new Error(`authentication failed (${resp.status}) — please re-login`);
  }
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(formatUpstreamError("status-v2", resp.status, body));
  }

  return resp.json() as Promise<StatusResponse>;
}
