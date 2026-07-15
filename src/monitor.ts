// src/monitor.ts
// Usage: bun run src/monitor.ts [--base-url URL] [--webhook URL] [--warn-percent 80]

async function main() {
  const args = process.argv.slice(2);
  let baseUrl = "http://127.0.0.1:3456";
  let webhook = "";
  let warnPercent = 80;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--base-url" && args[i + 1]) baseUrl = args[++i];
    else if (args[i] === "--webhook" && args[i + 1]) webhook = args[++i];
    else if (args[i] === "--warn-percent" && args[i + 1]) warnPercent = parseFloat(args[++i]);
  }

  baseUrl = baseUrl.replace(/\/+$/, "");

  const healthResp = await fetch(`${baseUrl}/health`);
  const health = (await healthResp.json()) as any;

  const usageResp = await fetch(`${baseUrl}/v1/usage`);
  const usage = (await usageResp.json()) as any;

  const ok = health.status === "ok" && health.logged_in;
  const percent = usage.usage_percent || 0;
  const exhausted = usage.quota_exhausted || false;

  const report = { ok, health, usage, checks: { ok, warnPercent, percent, exhausted } };
  console.log(JSON.stringify(report, null, 2));

  if (webhook && (!ok || percent >= warnPercent || exhausted)) {
    await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(report),
    });
    console.log(`[webhook] Sent to ${webhook}`);
  }

  process.exit(ok ? 0 : 2);
}

main().catch(e => {
  console.error(e);
  process.exit(2);
});