// src/capture.ts — simplified single-host MITM capture
import * as tls from "node:tls";
import * as net from "node:net";
import * as fs from "node:fs";
import * as path from "node:path";
import { $ } from "bun";

const CA_DIR = path.join(import.meta.dirname || ".", "..", "capture-ca");
const CA_KEY = path.join(CA_DIR, "ca-key.pem");
const CA_CERT = path.join(CA_DIR, "ca-cert.pem");
const LISTEN_PORT = parseInt(process.env.CAPTURE_PORT || "443");
const TARGET_HOST = process.env.CAPTURE_TARGET || "llm-api.atomgit.com";

// ---------------------------------------------------------------------------
// 1. Generate CA
// ---------------------------------------------------------------------------
async function ensureCA(): Promise<void> {
  fs.mkdirSync(CA_DIR, { recursive: true });
  if (fs.existsSync(CA_KEY) && fs.existsSync(CA_CERT)) {
    console.log(`[ca] Using existing CA: ${CA_CERT}`);
    return;
  }
  console.log("[ca] Generating root CA...");
  await $`openssl req -x509 -newkey rsa:2048 -keyout ${CA_KEY} -out ${CA_CERT} -days 3650 -subj "/CN=atomcode2api CA" -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" -nodes`.quiet();
  console.log(`[ca] CA: ${CA_CERT}`);
  console.log(`[ca] Trust CA: certutil -user -addstore Root ${CA_CERT}`);
}

// ---------------------------------------------------------------------------
// 2. Generate host cert
// ---------------------------------------------------------------------------
async function ensureHostCert(hostname: string): Promise<{ key: string; cert: string }> {
  const keyFile = path.join(CA_DIR, `${hostname}-key.pem`);
  const csrFile = path.join(CA_DIR, `${hostname}.csr`);
  const certFile = path.join(CA_DIR, `${hostname}-cert.pem`);

  if (fs.existsSync(keyFile) && fs.existsSync(certFile) && fs.statSync(certFile).size > 0) {
    return { key: fs.readFileSync(keyFile, "utf-8"), cert: fs.readFileSync(certFile, "utf-8") };
  }

  console.log(`[cert] Generating cert for ${hostname}...`);

  // Generate key + CSR
  await $`openssl req -new -newkey rsa:2048 -keyout ${keyFile} -out ${csrFile} -subj "/CN=${hostname}" -addext "subjectAltName=DNS:${hostname}" -nodes`.quiet();

  // Sign with CA
  const result = await $`openssl x509 -req -in ${csrFile} -CA ${CA_CERT} -CAkey ${CA_KEY} -CAcreateserial -days 365 -out ${certFile} -copy_extensions copy`.quiet();
  if (result.exitCode !== 0) {
    console.error("[cert] OpenSSL signing failed:", result.stderr.toString());
    throw new Error("Certificate signing failed");
  }

  // Clean up CSR
  fs.unlinkSync(csrFile);

  // Verify the cert
  const verify = await $`openssl verify -CAfile ${CA_CERT} ${certFile}`.quiet();
  console.log(`[cert] Verify: ${verify.stdout.toString().trim()}`);

  return { key: fs.readFileSync(keyFile, "utf-8"), cert: fs.readFileSync(certFile, "utf-8") };
}

// ---------------------------------------------------------------------------
// 3. Forward
// ---------------------------------------------------------------------------
function forwardToReal(
  req: { method: string; url: string; headers: Record<string, string>; body: Buffer },
  clientSocket: net.Socket,
  targetHost: string
) {
  console.log(`[forward] Connecting to real ${targetHost}:443...`);
  const realSocket = tls.connect({
    host: targetHost,
    port: 443,
    servername: targetHost,
    rejectUnauthorized: true,
  });

  realSocket.on("error", (err) => {
    console.error(`[forward] ${targetHost} error:`, err.message);
    if (!clientSocket.destroyed) clientSocket.end();
  });

  realSocket.on("secureConnect", () => {
    console.log(`[forward] Connected to ${targetHost}, forwarding request...`);
    const headerLines = [
      `${req.method} ${req.url} HTTP/1.1`,
      `Host: ${targetHost}`,
      ...Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`),
      `Content-Length: ${req.body.length}`,
      "",
      "",
    ].join("\r\n");

    realSocket.write(headerLines);
    if (req.body.length > 0) realSocket.write(req.body);
    realSocket.pipe(clientSocket);
  });
}

// ---------------------------------------------------------------------------
// 4. Parse HTTP
// ---------------------------------------------------------------------------
function parseHttpRequest(data: Buffer): {
  method: string; url: string; headers: Record<string, string>; body: Buffer;
} | null {
  const str = data.toString("utf-8");
  const headerEnd = str.indexOf("\r\n\r\n");
  if (headerEnd === -1) return null;

  const headerSection = str.slice(0, headerEnd);
  const lines = headerSection.split("\r\n");
  const [method, url] = lines[0].split(" ");

  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const colonIdx = lines[i].indexOf(":");
    if (colonIdx !== -1) {
      headers[lines[i].slice(0, colonIdx).trim().toLowerCase()] = lines[i].slice(colonIdx + 1).trim();
    }
  }

  return { method, url, headers, body: data.subarray(headerEnd + 4) };
}

// ---------------------------------------------------------------------------
// 5. Main
// ---------------------------------------------------------------------------
async function main() {
  await ensureCA();
  const hostCert = await ensureHostCert(TARGET_HOST);

  console.log("");
  console.log("[server] Starting TLS server...");

  const server = tls.createServer(
    {
      key: hostCert.key,
      cert: hostCert.cert,
      rejectUnauthorized: false,
    },
    (socket) => {
      const servername = (socket as any).servername || TARGET_HOST;
      console.log(`[tls] New connection, SNI: ${servername}`);
      const chunks: Buffer[] = [];

      socket.on("data", (data: Buffer) => {
        chunks.push(data);
        const full = Buffer.concat(chunks);
        const parsed = parseHttpRequest(full);
        if (!parsed) return;

        console.log("");
        console.log("=".repeat(80));
        console.log(`[CAPTURED] ${parsed.method} ${parsed.url}`);
        console.log("=".repeat(80));
        console.log("--- Headers ---");
        for (const [k, v] of Object.entries(parsed.headers)) {
          const display = k.startsWith("authorization") ? v.slice(0, 60) + "..." : v;
          console.log(`  ${k}: ${display}`);
        }
        console.log("");
        console.log("--- Body (first 500 chars) ---");
        console.log(parsed.body.toString("utf-8").slice(0, 500));
        console.log("");

        // Save dump
        const dumpFile = path.join(CA_DIR, `capture-${Date.now()}.json`);
        fs.writeFileSync(dumpFile, JSON.stringify({
          timestamp: new Date().toISOString(),
          method: parsed.method,
          url: parsed.url,
          headers: parsed.headers,
          body: parsed.body.toString("utf-8"),
        }, null, 2));
        console.log(`[dump] ${dumpFile}`);

        // Forward
        forwardToReal(parsed, socket, TARGET_HOST);
      });

      socket.on("close", () => console.log(`[tls] Connection closed`));
      socket.on("error", (err) => console.error(`[tls] Socket error:`, err.message));
    }
  );

  server.on("tlsClientError", (err) => {
    console.error("[tls] Client TLS error:", err.message);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EACCES" || err.code === "EADDRINUSE") {
      console.error(`[error] Port ${LISTEN_PORT} requires admin.`);
      process.exit(1);
    }
    throw err;
  });

  server.listen(LISTEN_PORT, () => {
    console.log("");
    console.log(`[server] Listening on :${LISTEN_PORT}, target: ${TARGET_HOST}`);
    console.log("");
    console.log("   Add to hosts:  127.0.0.1 " + TARGET_HOST);
    console.log("   Trust CA:       certutil -user -addstore Root " + CA_CERT);
    console.log("");
    console.log("   Then run: atomcode chat \"hello\"");
    console.log("   Ctrl+C to stop.");
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
