#!/usr/bin/env node
"use strict";

// Operator tooling for the app's Web Bot Auth identity. The browser runtime never
// imports this file. Run `npm run build:runtime` first so the compiled module
// exists.
//
//   node tools/web-bot-auth.js keygen   [--key <file>]
//   node tools/web-bot-auth.js directory --key <file> [--port 8787]
//   node tools/web-bot-auth.js check      --directory <https url>
//   node tools/web-bot-auth.js selftest   --key <file> --directory <https url> [--url <url>]
//
// The app generates and uses its own key at
// <userData>/harness-data/web-bot-auth-key.pem; pass that path to serve the
// directory for the in-app signer. `keygen` defaults to ~/.halo for standalone
// deployments. See contracts/WEB-BOT-AUTH.md.

const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const {
  buildDirectoryResponseHeaders,
  createRequestSigner,
  directoryBody,
  jwkThumbprint,
  loadOrCreateKey,
  verifyDirectoryResponse,
} = require("../main/harness/web-bot-auth");

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      args[token.slice(2)] = argv[index + 1] ?? "";
      index += 1;
    } else {
      args._.push(token);
    }
  }
  return args;
}

function defaultKeyFile() {
  return path.join(os.homedir(), ".halo", "web-bot-auth-key.pem");
}

async function keygen(args) {
  const keyFile = args.key || defaultKeyFile();
  const key = await loadOrCreateKey(keyFile);
  const jwksFile = `${keyFile}.jwks.json`;
  await fs.writeFile(jwksFile, directoryBody(key.publicJwk, key.keyId), { mode: 0o644 });
  console.log(`key file : ${keyFile}`);
  console.log(`keyid    : ${key.keyId}`);
  console.log(`jwks     : ${jwksFile}`);
  console.log("");
  console.log("Serve this JWKS at /.well-known/http-message-signatures-directory over https, then");
  console.log("register that directory URL with the verifier (Cloudflare dashboard > Bot Submission Form).");
}

async function check(args) {
  const target = args.directory;
  if (!target) throw new Error("--directory <https url> is required");
  let url;
  try { url = new URL(target); } catch { throw new Error("--directory must be a valid URL"); }
  if (url.protocol !== "https:") throw new Error("--directory must be https");
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/.well-known/http-message-signatures-directory";
  const response = await fetch(url, { headers: { accept: "application/http-message-signatures-directory+json" } });
  const contentType = response.headers.get("content-type") ?? "";
  console.log(`GET ${url.href} -> ${response.status} (${contentType || "no content-type"})`);
  if (response.status !== 200) throw new Error(`directory responded with ${response.status}`);
  if (!contentType.includes("application/http-message-signatures-directory+json")) {
    throw new Error("unexpected content-type; expected application/http-message-signatures-directory+json");
  }
  const body = await response.text();
  const headers = Object.fromEntries(response.headers.entries());
  let parsed;
  try { parsed = JSON.parse(body); } catch { throw new Error("directory body is not JSON"); }
  const keys = Array.isArray(parsed?.keys)
    ? parsed.keys.filter((key) => key?.kty === "OKP" && key?.crv === "Ed25519" && typeof key?.x === "string")
    : [];
  if (keys.length === 0) throw new Error("directory publishes no Ed25519 keys");
  let verified = 0;
  for (const key of keys) {
    const publicJwk = { kty: "OKP", crv: "Ed25519", x: key.x };
    const keyId = jwkThumbprint(publicJwk);
    const valid = verifyDirectoryResponse({ directoryUrl: url.href, headers, body, publicJwk });
    console.log(`key ${keyId}: ${valid ? "signature verifies" : "SIGNATURE FAILS"}`);
    if (valid) verified += 1;
  }
  if (verified === 0) throw new Error("no key in the directory signs this response");
  console.log(`ok: ${verified}/${keys.length} key(s) verify the signed directory response`);
}

async function directory(args) {
  const keyFile = args.key || defaultKeyFile();
  const port = Number(args.port || 8787);
  const key = await loadOrCreateKey(keyFile);
  const body = directoryBody(key.publicJwk, key.keyId);
  const server = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/.well-known/http-message-signatures-directory") {
      const authority = request.headers.host || `127.0.0.1:${port}`;
      let signatureHeaders;
      try {
        signatureHeaders = buildDirectoryResponseHeaders({ authority, keyId: key.keyId, privateKeyPem: key.privateKeyPem, body });
      } catch {
        response.writeHead(500).end();
        return;
      }
      response.writeHead(200, {
        "Content-Type": "application/http-message-signatures-directory+json",
        "Cache-Control": "max-age=86400",
        ...signatureHeaders,
      });
      response.end(body);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  console.log(`serving /.well-known/http-message-signatures-directory on http://127.0.0.1:${port} (keyid ${key.keyId})`);
  console.log("Expose it over https, e.g. cloudflared tunnel --url http://127.0.0.1:" + port);
  console.log("Use the resulting https origin as the key directory URL / Signature-Agent value.");
}

async function selftest(args) {
  const keyFile = args.key || defaultKeyFile();
  const directoryUrl = args.directory;
  const target = args.url || "https://crawltest.com/cdn-cgi/web-bot-auth";
  if (!directoryUrl) throw new Error("--directory <https url> is required (the registered key directory URL)");
  const signer = await createRequestSigner({ keyFile, directoryUrl });
  const headers = signer.sign(target);
  const response = await fetch(target, { method: "GET", headers, redirect: "manual" });
  const body = await response.text().catch(() => "");
  console.log(`GET ${target} -> ${response.status}`);
  if (body) console.log(body.slice(0, 400));
  console.log("");
  console.log("Interpretation (crawltest.com): 200 = key known and signature verified;");
  console.log("401 = message well formed but the key is unknown (expected until the directory is");
  console.log("registered and public); 400 = message malformed.");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (command === "keygen") return keygen(args);
  if (command === "directory") return directory(args);
  if (command === "check") return check(args);
  if (command === "selftest") return selftest(args);
  console.error("usage: node tools/web-bot-auth.js <keygen|directory|check|selftest> [options]");
  process.exitCode = 1;
}

main().catch((error) => {
  console.error("web-bot-auth tool failed:", error?.code ?? error?.message ?? error);
  process.exitCode = 1;
});
