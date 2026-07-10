// src/index.ts
// AtomCode OpenAI-Compatible Proxy Server
// Bun + Hono — single-file deployable.

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { cors } from "hono/cors";
import type { Context, Next } from "hono";

import { startLogin, pollLogin, exchangeToken } from "./auth";
import { claimPlan, listModels, getStatus, type ModelEntry } from "./codingplan";
import { loadAuth, clearAuth, getValidToken, isLoggedIn } from "./token-store";
import { getConfig, saveConfig } from "./config-store";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || "3456");
const PLATFORM_SERVER = process.env.ATOMCODE_PLATFORM_SERVER || "https://acs.atomgit.com";
const MODEL_CACHE_TTL_MS = 60_000;
let API_KEY = process.env.API_KEY || getConfig().api_key;
const MONITOR_INTERVAL_MS = parseInt(process.env.MONITOR_INTERVAL || "300000"); // 5min default, 0=disable
let MONITOR_WEBHOOK = process.env.MONITOR_WEBHOOK || getConfig().monitor_webhook;
let MONITOR_WARN_PERCENT = parseFloat(process.env.MONITOR_WARN_PERCENT || String(getConfig().monitor_warn_percent));
let AUTO_CLAIM_PRO = process.env.AUTO_CLAIM_PRO === "true" || getConfig().auto_claim_pro;

// ---------------------------------------------------------------------------
// Auth middleware — protect /v1/* endpoints with optional API key
// ---------------------------------------------------------------------------
async function authMiddleware(c: Context, next: Next) {
  if (!API_KEY) return next(); // no key set → skip auth
  const auth = c.req.header("Authorization") || "";
  const key = c.req.header("x-api-key") || "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : key;
  if (provided !== API_KEY) {
    return c.json({ error: { message: "Invalid API key", type: "authentication_error" } }, 401);
  }
  return next();
}

// ---------------------------------------------------------------------------
// Model cache — avoids calling CodingPlan API on every request
// ---------------------------------------------------------------------------
let modelCache: { models: ModelEntry[]; expiresAt: number } | null = null;

async function getCachedModels(): Promise<ModelEntry[]> {
  if (modelCache && Date.now() < modelCache.expiresAt) {
    return modelCache.models;
  }
  const models = await listModels("Max");
  modelCache = { models, expiresAt: Date.now() + MODEL_CACHE_TTL_MS };
  return models;
}

function bustModelCache(): void {
  modelCache = null;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = new Hono();

// CORS — allow any origin for OpenAI clients
app.use("*", cors({
  origin: "*",
  allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
  allowHeaders: ["Authorization", "Content-Type", "x-request-id"],
  exposeHeaders: ["x-request-id"],
}));

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get("/health", (c) => c.json({ status: "ok", logged_in: isLoggedIn() }));

// ---------------------------------------------------------------------------
// Static pages
// ---------------------------------------------------------------------------

// Root — Dashboard (re-read on every request → instant hot-reload)
app.get("/", async (c) => {
  const html = await Bun.file(new URL("./pages/dashboard.html", import.meta.url)).text();
  return c.html(html);
});

// Login page — handles the full OAuth flow
app.get("/login", (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Login — atomcode2api</title>
<style>
  *,::before,::after{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',system-ui,-apple-system,sans-serif;background:#09090b;color:#fafafa;min-height:100vh;display:flex;align-items:center;justify-content:center;-webkit-font-smoothing:antialiased}
  .card{background:#0f0f10;border:1px solid #27272a80;border-radius:.5rem;padding:2rem;max-width:440px;width:90%}
  .logo{width:48px;height:48px;border-radius:.5rem;background:#7c3aed;display:flex;align-items:center;justify-content:center;font-size:1.25rem;font-weight:700;color:#fff;margin:0 auto 1rem}
  h1{font-size:1.25rem;font-weight:600;text-align:center;margin-bottom:.25rem}
  .sub{text-align:center;color:#a1a1aa;font-size:.875rem;margin-bottom:1.5rem}
  .steps{display:flex;flex-direction:column;gap:.5rem;margin-bottom:1.25rem}
  .step{display:flex;align-items:center;gap:.75rem;padding:.75rem 1rem;border-radius:.5rem;background:#09090b;border:1px solid #27272a80;transition:border-color .2s}
  .step .icon{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.75rem;font-weight:600;flex-shrink:0}
  .step.pending .icon{background:#18181b;color:#52525b}
  .step.active .icon{background:#7c3aed22;color:#a78bfa}
  .step.done .icon{background:#166534;color:#4ade80}
  .step.error .icon{background:#7f1d1d;color:#fca5a5}
  .step .text{flex:1;font-size:.875rem}
  .step.pending .text{color:#52525b}
  .step.active .text{color:#e4e4e7}
  .step.done .text{color:#a1a1aa}
  .step.error .text{color:#fca5a5}
  .btn{display:inline-flex;align-items:center;justify-content:center;width:100%;padding:.625rem 1.25rem;border-radius:.5rem;font-size:.875rem;font-weight:500;cursor:pointer;border:none;color:#fff;background:#7c3aed;transition:background .15s}
  .btn:hover{background:#6d28d9}
  .btn:disabled{background:#27272a;color:#52525b;cursor:not-allowed}
  .btn-ghost{display:inline-flex;align-items:center;justify-content:center;width:100%;margin-top:.75rem;padding:.5rem;border-radius:.5rem;font-size:.8125rem;color:#a1a1aa;background:transparent;border:none;cursor:pointer;text-decoration:none}
  .btn-ghost:hover{color:#e4e4e7;background:#27272a44}
  .alert{padding:.75rem 1rem;border-radius:.5rem;margin-bottom:1rem;font-size:.8125rem}
  .alert-error{background:#7f1d1d22;border:1px solid #7f1d1d44;color:#fca5a5}
  .alert-success{background:#16653422;border:1px solid #16653444;color:#4ade80}
  .url-block{background:#09090b;border:1px solid #27272a80;border-radius:.5rem;padding:.75rem;margin-bottom:1rem;word-break:break-all;font-family:monospace;font-size:.75rem;color:#a78bfa}
  .url-block a{color:#a78bfa}
  .polling{text-align:center;font-size:.75rem;color:#71717a;margin-top:.5rem}
  @keyframes spin{to{transform:rotate(360deg)}}
  .spinner{display:inline-block;width:14px;height:14px;border:2px solid #27272a;border-top-color:#7c3aed;border-radius:50%;animation:spin .6s linear infinite;margin-right:6px;vertical-align:middle}
</style>
</head>
<body>
<div class="card">
  <div class="logo">A</div>
  <h1>Login with AtomGit</h1>
  <p class="sub">Authorize atomcode2api to use your CodingPlan quota</p>

  <div id="steps" class="steps">
    <div class="step pending" id="step-start">
      <span class="icon">1</span><span class="text">Start login</span>
    </div>
    <div class="step pending" id="step-browser">
      <span class="icon">2</span><span class="text">Authorize in browser</span>
    </div>
    <div class="step pending" id="step-token">
      <span class="icon">3</span><span class="text">Exchange token</span>
    </div>
  </div>

  <div id="alert-error" class="alert alert-error" style="display:none"></div>
  <div id="alert-success" class="alert alert-success" style="display:none"></div>
  <div id="login-url" class="url-block" style="display:none"></div>
  <div id="polling-msg" class="polling" style="display:none"><span class="spinner"></span>Waiting for authorization...</div>

  <button class="btn" id="btn-start" onclick="startFlow()">Start Login</button>
  <a href="/" class="btn-ghost">← Back to dashboard</a>
</div>

<script>
  let state=null,pollTimer=null,authWindow=null;
  function setStep(id,c){document.getElementById(id).className='step '+c}
  function show(e,msg){const el=document.getElementById(e);el.style.display='block';el.textContent=msg}
  function hide(e){document.getElementById(e).style.display='none'}

  async function startFlow(){
    const btn=document.getElementById('btn-start');
    btn.disabled=true;btn.textContent='Starting...';
    hide('alert-error');hide('alert-success');
    try{
      setStep('step-start','active');
      const r=await fetch('/api/auth/start',{method:'POST'});
      if(!r.ok)throw new Error(await r.text());
      const d=await r.json();state=d.state;
      setStep('step-start','done');setStep('step-browser','active');
      const u=document.getElementById('login-url');
      u.style.display='block';
      u.innerHTML='<a href="'+d.login_url+'" target="_blank">Open AtomGit authorization page →</a>';
      try{authWindow=window.open(d.login_url,'_blank','width=600,height=700')}catch(e){}
      btn.textContent='Waiting...';btn.disabled=true;
      document.getElementById('polling-msg').style.display='block';
      pollTimer=setInterval(poll,2000);
    }catch(e){show('alert-error',e.message);btn.disabled=false;btn.textContent='Retry'}
  }

  async function poll(){
    try{
      const r=await fetch('/api/auth/poll?state='+encodeURIComponent(state));
      if(!r.ok)return;
      const d=await r.json();
      if(d.valid){clearInterval(pollTimer);setStep('step-browser','done');setStep('step-token','active');await exchange()}
    }catch(e){}
  }

  async function exchange(){
    try{
      const r=await fetch('/api/auth/exchange',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({state})});
      if(!r.ok)throw new Error(await r.text());
      const u=await r.json();setStep('step-token','done');
      show('alert-success','Logged in as '+(u.name||u.username)+' — redirecting...');
      document.getElementById('btn-start').textContent='Done!';
      hide('login-url');hide('polling-msg');
      if(authWindow&&!authWindow.closed)try{authWindow.close()}catch(e){}
      setTimeout(()=>{location.href='/'},1500);
    }catch(e){show('alert-error','Token exchange failed: '+e.message);setStep('step-token','error');document.getElementById('btn-start').disabled=false;document.getElementById('btn-start').textContent='Retry'}
  }

  fetch('/api/auth/status').then(r=>r.json()).then(d=>{
    if(d.logged_in){show('alert-success','Already logged in as '+(d.user?.name||d.user?.username));document.getElementById('btn-start').textContent='Re-login'}
  });
</script>
</body>
</html>`);
});

// ---------------------------------------------------------------------------
// Auth API
// ---------------------------------------------------------------------------

// Get auth status
app.get("/api/auth/status", (c) => {
  const authed = isLoggedIn();
  const auth = authed ? loadAuth() : null;
  return c.json({
    logged_in: authed,
    user: auth ? { id: auth.user.id, username: auth.user.username, name: auth.user.name, email: auth.user.email } : null,
    platform_server: PLATFORM_SERVER,
  });
});

// Start OAuth
app.post("/api/auth/start", async (c) => {
  try {
    const result = await startLogin();
    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Poll OAuth
app.get("/api/auth/poll", async (c) => {
  const state = c.req.query("state");
  if (!state) return c.json({ error: "Missing state" }, 400);
  try {
    const valid = await pollLogin(state);
    return c.json({ valid });
  } catch (e: any) {
    return c.json({ error: e.message, valid: false }, 500);
  }
});

// Exchange token
app.post("/api/auth/exchange", async (c) => {
  const { state } = await c.req.json<{ state: string }>();
  if (!state) return c.json({ error: "Missing state" }, 400);
  try {
    const auth = await exchangeToken(state);
    return c.json({ id: auth.user.id, username: auth.user.username, name: auth.user.name, email: auth.user.email });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// Logout
app.delete("/api/auth/logout", (c) => {
  clearAuth();
  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// CodingPlan API
// ---------------------------------------------------------------------------

app.get("/api/codingplan/status", async (c) => {
  try {
    const status = await getStatus();
    return c.json(status);
  } catch (e: any) {
    return c.json({ error: e.message }, e.message.includes("authentication failed") ? 401 : 500);
  }
});

app.post("/api/codingplan/claim", async (c) => {
  const { plan_type } = await c.req.json<{ plan_type: string }>();
  if (!plan_type) return c.json({ error: "Missing plan_type" }, 400);
  try {
    const result = await claimPlan(plan_type);
    return c.json(result);
  } catch (e: any) {
    return c.json({ error: e.message }, e.message.includes("authentication failed") ? 401 : 500);
  }
});

// ---------------------------------------------------------------------------
// OpenAI-compatible API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// OpenAI-compatible API (protected by API key if set)
// ---------------------------------------------------------------------------
app.use("/v1/*", authMiddleware);

// GET /v1/models
app.get("/v1/models", async (c) => {
  try {
    const models = await getCachedModels();

    // Only return plan_available models, convert to OpenAI format
    const data = models
      .filter((m) => m.plan_available)
      .map((m: ModelEntry) => ({
        id: m.display_model_name,
        object: "model" as const,
        created: Math.floor(Date.now() / 1000),
        owned_by: m.display_model_name.split("/")[0] || "atomgit",
      }));

    return c.json({ object: "list", data });
  } catch (e: any) {
    return c.json(
      {
        error: { message: e.message, type: e.message.includes("authentication failed") ? "server_error" : "server_error", code: "internal_error" },
      },
      e.message.includes("authentication failed") ? 401 : 500
    );
  }
});

// Retry wrapper with exponential backoff + Retry-After support.
// Accepts individual params so body (a string) is recreated fresh on each retry
// (avoiding "body already used" errors when init.body is a ReadableStream).
async function fetchWithRetry(
  url: string,
  method: string,
  headers: Record<string, string>,
  bodyStr: string,
  signal: AbortSignal,
  retries = 3,
): Promise<Response> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const resp = await fetch(url, { method, headers, body: bodyStr, signal });
    if (resp.status !== 429 || attempt === retries) return resp;
    const retryAfter = parseFloat(resp.headers.get("Retry-After") || "");
    const waitMs = Number.isFinite(retryAfter) ? retryAfter * 1000 : Math.min(2 ** attempt * 1000, 8000);
    console.log(`[429] retry in ${(waitMs / 1000).toFixed(1)}s (attempt ${attempt + 1}/${retries})`);
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
  throw new Error("retry exhausted");
}

// POST /v1/chat/completions
app.post("/v1/chat/completions", async (c) => {
  // Check auth first
  if (!isLoggedIn()) {
    return c.json(
      { error: { message: "Not logged in. Please visit /login first.", type: "server_error", code: "internal_error" } },
      401
    );
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: { message: "Invalid JSON body", type: "invalid_request_error", code: "invalid_request" } },
      400
    );
  }

  const stream = body.stream === true;

  try {
    const token = await getValidToken();
    const models = await getCachedModels();
    const requestedModel = body.model;
    const modelEntry = models.find(
      (m) => m.display_model_name === requestedModel && m.plan_available
    );

    if (!modelEntry) {
      return c.json(
        {
          error: {
            message: `Model '${requestedModel}' not found or not available on your plan.`,
            type: "invalid_request_error",
            code: "model_not_found",
          },
        },
        404
      );
    }

    // Model name mapping: CodingPlan display name → direct API model name
    const MODEL_NAME_MAP: Record<string, string> = {
      "deepseek-v4-flash": "deepseek-ai/DeepSeek-V4-Flash",
      "deepseek-v4": "deepseek-ai/DeepSeek-V4-Flash",
      "deepseek-r1": "deepseek-ai/DeepSeek-R1",
      "qwen-vl": "Qwen/Qwen3-VL-8B-Instruct",
      "qwen3-vl": "Qwen/Qwen3-VL-8B-Instruct",
      "qwen3-vl-8b": "Qwen/Qwen3-VL-8B-Instruct",
      "Qwen/Qwen3-VL-8B-Instruct": "Qwen/Qwen3-VL-8B-Instruct",
      "glm-5": "GLM-5.2",
      "GLM-5.2": "GLM-5.2",
    };
    const upstreamModel = MODEL_NAME_MAP[requestedModel] || requestedModel;

    // Use CodingPlan direct API (no signing required!)
    const upstreamUrl = "https://api.gitcode.com/api/v5/chat/completions";

    const upstreamBody = {
      ...body,
      model: upstreamModel,
      stream,
    };

    const bodyStr = JSON.stringify(upstreamBody);

    const requestHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "atomcode/4.26.0",
    };

    const resp = await fetchWithRetry(upstreamUrl, "POST", requestHeaders, bodyStr, AbortSignal.timeout(300_000), 3);

    if (!resp.ok) {
      const errBody = await resp.text();
      // Try to pass through upstream error as OpenAI format
      try {
        const errJson = JSON.parse(errBody);
        return c.json(errJson, resp.status as any);
      } catch {
        return c.json(
          {
            error: { message: `Upstream error (${resp.status}): ${errBody.slice(0, 200)}`, type: "server_error", code: "internal_error" },
          },
          resp.status as any
        );
      }
    }

    if (!stream) {
      // Non-streaming — just pass through the JSON
      const data = await resp.json();
      return c.json(data);
    }

    // Streaming — use Hono SSE streaming
    if (!resp.body) {
      return c.json({ error: { message: "No response body from upstream", type: "server_error" } }, 500);
    }

    return streamSSE(c, async (sseStream) => {
      const reader = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith("data: ")) {
              const data = trimmed.slice(6);
              if (data === "[DONE]") {
                await sseStream.writeSSE({ data: "[DONE]" });
                return;
              }
              await sseStream.writeSSE({ data });
            } else if (trimmed.startsWith("event: ")) {
              await sseStream.writeSSE({ event: trimmed.slice(7), data: "" });
            } else if (trimmed === "") {
              // Empty line — boundary
              continue;
            }
          }
        }

        // Flush remaining buffer
        if (buffer.trim()) {
          if (buffer.trim().startsWith("data: ")) {
            const data = buffer.trim().slice(6);
            await sseStream.writeSSE({ data });
          }
        }
      } catch (e: any) {
        await sseStream.writeSSE({ event: "error", data: JSON.stringify({ message: e.message }) });
      }
    });
  } catch (e: any) {
    if (stream) {
      return streamSSE(c, async (sseStream) => {
        await sseStream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: e.message }),
        });
      });
    }
    return c.json(
      { error: { message: e.message, type: "server_error", code: "internal_error" } },
      500
    );
  }
});

// GET /v1/usage — summarized usage view
app.get("/v1/usage", async (c) => {
  try {
    const status = await getStatus();
    const plan = status.codingplan_free || {};
    const windows = status.rate_limit_windows || [];
    const activeWindow = windows[0] || {};
    const usage = status.current_usage || {};
    return c.json({
      object: "usage",
      plan_name: (plan as any).plan_name || (status as any).plan_type || "unknown",
      plan_type: (status as any).plan_type,
      expires_at: (status as any).expires_at || (plan as any).expires_at,
      window_hours: (usage as any).window_hours || (activeWindow as any).window_hours,
      window_limit: (usage as any).window_token_limit || (activeWindow as any).call_limit,
      used: (usage as any).window_tokens_used || (activeWindow as any).calls_used,
      usage_percent: (usage as any).usage_percent || (activeWindow as any).usage_percent,
      reset_at: (usage as any).reset_at_display || (activeWindow as any).reset_at_display,
      quota_exhausted: (status as any).window_quota_exhausted || (activeWindow as any).quota_exhausted,
      remaining_days: (plan as any).remaining_days,
      total_days: (plan as any).total_days,
    });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ---------------------------------------------------------------------------
// Background monitoring — periodic usage check + optional webhook alerts
// ---------------------------------------------------------------------------
if (MONITOR_INTERVAL_MS > 0) {
  let lastAlertPercent = 0;

  async function monitorLoop() {
    if (!isLoggedIn()) return;
    try {
      const status = await getStatus();
      const plan = status.codingplan_free || {} as any;
      const windows = status.rate_limit_windows || [];
      const activeWindow = windows[0] || {} as any;
      const usage = status.current_usage || {} as any;
      const percent = usage.usage_percent || activeWindow.usage_percent || 0;
      const exhausted = status.window_quota_exhausted || activeWindow.quota_exhausted || false;

      if (exhausted) {
        console.log(`[monitor] ⚠️ Quota exhausted!`);
        if (MONITOR_WEBHOOK) await sendAlert("quota_exhausted", { percent, exhausted });
      } else if (percent >= MONITOR_WARN_PERCENT && percent > lastAlertPercent) {
        console.log(`[monitor] ⚠️ Usage ${percent}% (threshold: ${MONITOR_WARN_PERCENT}%)`);
        if (MONITOR_WEBHOOK) await sendAlert("usage_high", { percent });
        lastAlertPercent = percent;
      } else if (percent < MONITOR_WARN_PERCENT * 0.5) {
        lastAlertPercent = 0; // reset alert threshold once usage drops below 50% of warn level
      }
    } catch (e: any) {
      console.log(`[monitor] check failed: ${e.message}`);
    }
  }

  async function sendAlert(type: string, data: any) {
    try {
      await fetch(MONITOR_WEBHOOK, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, ...data, timestamp: new Date().toISOString(), service: "atomcode2api" }),
      });
    } catch {}
  }

  setInterval(monitorLoop, MONITOR_INTERVAL_MS);
  monitorLoop(); // run immediately on start
}

// ---------------------------------------------------------------------------
// Background auto-claim — claim Pro daily at Beijing 10:00 window
// ---------------------------------------------------------------------------
if (AUTO_CLAIM_PRO) {
  const BJT_OFFSET = 8 * 3600 * 1000;
  let claimedToday = ""; // date string to avoid double-claim

  async function claimProOnce(token: string) {
    const resp = await fetch("https://api.gitcode.com/api/v5/coding-plan/claim-v2", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "atomcode/4.26.0",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ plan_type: "Pro" }),
    });
    return resp.json() as any;
  }

  async function claimLoop() {
    if (!getConfig().auto_claim_pro) return; // respect runtime config changes
    const now = new Date(Date.now() + BJT_OFFSET);
    const today = now.toISOString().slice(0, 10);
    if (claimedToday === today) return; // already done

    const h = now.getUTCHours(), m = now.getUTCMinutes(), s = now.getUTCSeconds(), ms = now.getUTCMilliseconds();
    const totalMs = (h * 3600 + m * 60 + s) * 1000 + ms;
    const startMs = (9 * 3600 + 59 * 60 + 59) * 1000 + 800;   // 09:59:59.800
    const endMs   = (10 * 3600 + 0 * 60 + 59) * 1000 + 800;   // 10:00:59.800

    if (totalMs < startMs || totalMs > endMs) return; // not in window

    const token = await getValidToken().catch(() => "");
    if (!token) return;

    let success = false;
    while (true) {
      const now2 = new Date(Date.now() + BJT_OFFSET);
      const ms2 = (now2.getUTCHours() * 3600 + now2.getUTCMinutes() * 60 + now2.getUTCSeconds()) * 1000 + now2.getUTCMilliseconds();
      if (ms2 > endMs) break;

      try {
        const result = await claimProOnce(token);
        console.log(`[claim-pro] ${result.message || JSON.stringify(result)}`);
        if (result.success) { success = true; break; }
      } catch (e: any) {
        console.log(`[claim-pro] error: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, 200));
    }

    claimedToday = today;
    if (success) console.log(`[claim-pro] Pro claimed!`);
    else console.log(`[claim-pro] window ended, will retry tomorrow`);
  }

  // Check every 30s — window is 1min, so we'll hit it at least twice
  setInterval(claimLoop, 30000);
  console.log(`[claim-pro] Auto-claim Pro enabled (daily at 10:00 BJT)`);
}

// ---------------------------------------------------------------------------
// Config API
// ---------------------------------------------------------------------------
app.get("/api/config", (c) => {
  return c.json({
    auto_claim_pro: AUTO_CLAIM_PRO,
    monitor_webhook: MONITOR_WEBHOOK,
    monitor_warn_percent: MONITOR_WARN_PERCENT,
    api_key: API_KEY ? "***" + API_KEY.slice(-4) : "",
  });
});

app.patch("/api/config", async (c) => {
  try {
    const body = await c.req.json();
    const cfg = saveConfig(body);
    // Apply runtime changes
    if (body.auto_claim_pro !== undefined) AUTO_CLAIM_PRO = body.auto_claim_pro;
    if (body.monitor_webhook !== undefined) MONITOR_WEBHOOK = body.monitor_webhook;
    if (body.monitor_warn_percent !== undefined) MONITOR_WARN_PERCENT = body.monitor_warn_percent;
    if (body.api_key !== undefined && !body.api_key.startsWith("***")) API_KEY = body.api_key;
    return c.json({ success: true, config: getConfig() });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
export default {
  port: PORT,
  fetch: app.fetch,
};

console.log(`atomcode2api running on http://localhost:${PORT}`);
console.log(`  Auth:    ${API_KEY ? "API key required" : "no auth (set API_KEY env to enable)"}`);
console.log(`  Monitor: ${MONITOR_INTERVAL_MS > 0 ? `every ${MONITOR_INTERVAL_MS / 1000}s, warn at ${MONITOR_WARN_PERCENT}%` + (MONITOR_WEBHOOK ? ", webhook enabled" : "") : "disabled"}`);
console.log(`  Claim:   ${AUTO_CLAIM_PRO ? "auto-claim Pro at 10:00 BJT daily" : "disabled (set AUTO_CLAIM_PRO=true to enable)"}`);
console.log(`  Login:   http://localhost:${PORT}/login`);
console.log(`  API:     http://localhost:${PORT}/v1/chat/completions`);
console.log(`  Usage:   http://localhost:${PORT}/v1/usage`);
console.log(`  Health: http://localhost:${PORT}/health`);
