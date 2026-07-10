// src/http-capture.ts
// Plain HTTP capture proxy — captures atomcode's signed request headers,
// then forwards to the REAL IP (bypassing hosts file) for validation.
import * as dns from "node:dns";
import * as tls from "node:tls";
import * as net from "node:net";

const LISTEN_PORT = parseInt(process.env.CAPTURE_PORT || "19999");
const REAL_HOST = "llm-api.atomgit.com";
const REAL_PORT = 443;

// Resolve real IP, bypassing hosts file
function resolveRealIp(): Promise<string> {
  return new Promise((resolve, reject) => {
    // Use Google DNS to get real IP (bypasses local hosts)
    const resolver = new dns.promises.Resolver();
    resolver.setServers(["8.8.8.8", "1.1.1.1"]);
    resolver.resolve4(REAL_HOST).then((addrs) => {
      console.log(`[dns] ${REAL_HOST} → ${addrs[0]} (via 8.8.8.8)`);
      resolve(addrs[0]);
    }).catch(() => {
      // Fallback to system DNS
      dns.promises.resolve4(REAL_HOST).then((addrs) => {
        console.log(`[dns] ${REAL_HOST} → ${addrs[0]} (system DNS, may be overridden by hosts)`);
        resolve(addrs[0]);
      }).catch(reject);
    });
  });
}

// Forward request to real HTTPS server (bypassing hosts file)
function forwardToReal(
  method: string, path: string, headers: Record<string, string>, body: string,
  realIp: string
): Promise<{ status: number; headers: Record<string,string>; body: string }> {
  return new Promise((resolve, reject) => {
    console.log(`[forward] → ${method} https://${REAL_HOST}${path}`);

    const socket = tls.connect({
      host: realIp,
      port: REAL_PORT,
      servername: REAL_HOST,
      rejectUnauthorized: true,
    });

    socket.on("secureConnect", () => {
      // Build HTTP request — strip double /v1 from path
      const cleanPath = path.startsWith("/v1") ? path : path;

      const headerLines = [
        `${method} ${cleanPath} HTTP/1.1`,
        `Host: ${REAL_HOST}`,
        ...Object.entries(headers)
          .filter(([k]) => !["host", "connection", "transfer-encoding", "content-length"].includes(k))
          .map(([k, v]) => `${k}: ${v}`),
        `Content-Length: ${Buffer.byteLength(body)}`,
        "Connection: close",
        "",
        "",
      ].join("\r\n");

      socket.write(headerLines);
      if (body) socket.write(body);

      // Read response
      let responseData = "";
      socket.on("data", (chunk: Buffer) => { responseData += chunk.toString("utf-8"); });

      socket.on("end", () => {
        const headerEnd = responseData.indexOf("\r\n\r\n");
        if (headerEnd === -1) {
          resolve({ status: 502, headers: {}, body: "Bad gateway" });
          return;
        }

        const headerSection = responseData.slice(0, headerEnd);
        const respBody = responseData.slice(headerEnd + 4);

        const lines = headerSection.split("\r\n");
        const statusLine = lines[0];
        const statusMatch = statusLine.match(/HTTP\/\d\.\d (\d+)/);
        const status = statusMatch ? parseInt(statusMatch[1]) : 502;

        const respHeaders: Record<string, string> = {};
        for (let i = 1; i < lines.length; i++) {
          const colonIdx = lines[i].indexOf(":");
          if (colonIdx !== -1) {
            respHeaders[lines[i].slice(0, colonIdx).trim().toLowerCase()] = lines[i].slice(colonIdx + 1).trim();
          }
        }

        console.log(`[forward] ← ${status} (${respBody.length} bytes)`);
        resolve({ status, headers: respHeaders, body: respBody });
      });

      socket.on("error", (err) => reject(err));
    });

    socket.on("error", (err) => reject(err));
  });
}

// ── Main ──
async function main() {
  const realIp = await resolveRealIp();

  const server = Bun.serve({
    port: LISTEN_PORT,
    async fetch(req) {
      const method = req.method;
      const url = new URL(req.url);
      const path = url.pathname + url.search;

      const reqHeaders: Record<string, string> = {};
      req.headers.forEach((v, k) => { reqHeaders[k] = v; });
      const reqBody = await req.text();

      // ── CAPTURE ──
      console.log("");
      console.log("=".repeat(80));
      console.log(`[CAPTURED] ${method} ${path}`);
      console.log("=".repeat(80));
      const sigHeaders = ["x-atomcode-alg","x-atomcode-nonce","x-atomcode-sig","x-atomcode-ts","x-atomcode-ver","x-atomcode-session-id","authorization"];
      console.log("--- Signature Headers ---");
      for (const h of sigHeaders) {
        if (reqHeaders[h]) {
          const display = h === "authorization" ? reqHeaders[h].slice(0, 60) + "..." : reqHeaders[h];
          console.log(`  ${h}: ${display}`);
        }
      }
      console.log("--- Body (first 300 chars) ---");
      console.log(reqBody.slice(0, 300));

      const dumpFile = `capture-http-${Date.now()}.json`;
      await Bun.write(dumpFile, JSON.stringify({
        timestamp: new Date().toISOString(),
        method, path, headers: reqHeaders, body: reqBody,
      }, null, 2));
      console.log(`[dump] ${dumpFile}`);

      // ── FORWARD to real IP ──
      try {
        const result = await forwardToReal(method, path, reqHeaders, reqBody, realIp);
        return new Response(result.body, { status: result.status, headers: result.headers as any });
      } catch (err: any) {
        console.error(`[forward] Error: ${err.message}`);
        return new Response(JSON.stringify({ error: err.message }), {
          status: 502, headers: { "Content-Type": "application/json" },
        });
      }
    },
  });

  console.log(`[server] HTTP capture on :${LISTEN_PORT} → ${REAL_HOST}:${REAL_PORT} (${realIp})`);
  console.log(`[server] base_url = http://${REAL_HOST}:${LISTEN_PORT}/v1`);
  console.log("");
}

main().catch(console.error);
