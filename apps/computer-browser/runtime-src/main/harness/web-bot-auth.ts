"use strict";

// Web Bot Auth request signing (draft-meunier-web-bot-auth-architecture-02,
// RFC 9421 profile). Opt-in: Halo adds a cryptographic identity to its automated
// browser requests so a site that verifies the standard can recognize the
// declared agent instead of challenging it. It is never used to pass a human
// check, and on sites that do not verify signatures the requests only carry
// three extra headers.
//
// Wire format is pinned to Cloudflare's reference test vectors:
//   - component list ("@authority" "signature-agent"), bare Signature-Agent
//     string, params created;keyid;alg;expires;nonce;tag
//   - nonce: 64 random bytes, canonical base64, short expires (replay bound)
//   - directory response: ("@authority";req "content-digest"), tag
//     http-message-signatures-directory
// See contracts/WEB-BOT-AUTH.md for enablement and hosting.

const { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign: signPayload, verify: verifyPayload } = require("node:crypto");
const fs = require("node:fs/promises");
const fsConstants = require("node:fs").constants;
const path = require("node:path");

type Json = Record<string, any>;

interface Ed25519PublicJwk { kty: "OKP"; crv: "Ed25519"; x: string }
interface LoadedKey { privateKeyPem: string; publicJwk: Ed25519PublicJwk; keyId: string }
interface RequestSigner {
  keyId: string;
  publicJwk: Ed25519PublicJwk;
  directoryJson: string;
  sign(url: string, overrides?: { now?: number; created?: number; expires?: number; nonce?: string; label?: string }): Record<string, string> | null;
}

const DEFAULT_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 3600;
const DIRECTORY_TTL_SECONDS = 3600;
const NONCE_BYTES = 64;
const CLOCK_SKEW_SECONDS = 5;
const SIGNATURE_LABEL = "sig1";
const DIRECTORY_LABEL = "binding0";
const COMPONENTS_WITH_AGENT = `("@authority" "signature-agent")`;
const COMPONENTS_AUTHORITY_ONLY = `("@authority")`;
const DIRECTORY_COMPONENTS = `("@authority";req "content-digest")`;
const REQUEST_TAG = "web-bot-auth";
const DIRECTORY_TAG = "http-message-signatures-directory";

function toSeconds(milliseconds: number): number {
  return Math.floor(milliseconds / 1000);
}

function clampTtl(value: unknown, fallback: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

// RFC 7638 canonical form; RFC 8037 Appendix A.3 covers Ed25519 (OKP) keys.
function jwkThumbprint(jwk: Ed25519PublicJwk): string {
  return createHash("sha256").update(JSON.stringify({ crv: "Ed25519", kty: "OKP", x: jwk.x })).digest("base64url");
}

function authorityOf(url: unknown): string | null {
  if (typeof url !== "string" || url.length === 0) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.host;
  } catch {
    return null;
  }
}

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0")) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && Boolean(parsed.hostname) && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

function publicJwkFromPrivate(privateKeyPem: string): Ed25519PublicJwk {
  const exported = createPublicKey(createPrivateKey(privateKeyPem)).export({ format: "jwk" }) as Json;
  const x = String(exported.x ?? "");
  if (exported.kty !== "OKP" || exported.crv !== "Ed25519" || x.length === 0) throw new Error("web_bot_auth_unsupported_key");
  return { kty: "OKP", crv: "Ed25519", x };
}

async function readKeyFile(keyFile: string): Promise<string | null> {
  try {
    const handle = await fs.open(keyFile, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    try { return await handle.readFile("utf8"); } finally { await handle.close(); }
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

// Creates the install's Ed25519 key once (0600, no symlink following) and loads
// it on later runs. The key never leaves this machine; the site only ever sees
// the derived public key that the operator publishes in the key directory.
async function loadOrCreateKey(keyFile: string): Promise<LoadedKey> {
  if (typeof keyFile !== "string" || keyFile.length === 0 || keyFile.includes("\0")) throw new Error("web_bot_auth_invalid_key_file");
  const existing = await readKeyFile(keyFile);
  if (existing !== null) {
    if (!existing.includes("BEGIN PRIVATE KEY")) throw new Error("web_bot_auth_invalid_key");
    const publicJwk = publicJwkFromPrivate(existing);
    return { privateKeyPem: existing, publicJwk, keyId: jwkThumbprint(publicJwk) };
  }
  await fs.mkdir(path.dirname(keyFile), { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  try {
    await fs.writeFile(keyFile, pem, { mode: 0o600, flag: "wx" });
  } catch (error: any) {
    if (error?.code !== "EEXIST") throw error;
    const raced = await readKeyFile(keyFile);
    if (raced === null) throw error;
    const publicJwk = publicJwkFromPrivate(raced);
    return { privateKeyPem: raced, publicJwk, keyId: jwkThumbprint(publicJwk) };
  }
  const publicJwk = publicJwkFromPrivate(pem);
  return { privateKeyPem: pem, publicJwk, keyId: jwkThumbprint(publicJwk) };
}

// The published JWKS body: object shape follows the directory draft's example.
function directoryBody(publicJwk: Ed25519PublicJwk, keyId: string): string {
  return JSON.stringify({ keys: [{ kty: "OKP", crv: "Ed25519", kid: keyId, x: publicJwk.x, use: "sig" }] });
}

interface RequestHeaderOptions {
  url: string;
  directoryUrl: string;
  keyId: string;
  privateKeyPem: string;
  now?: number;
  created?: number;
  expires?: number;
  nonce?: string;
  label?: string;
  ttlSeconds?: number;
  includeSignatureAgent?: boolean;
}

// Returns the three Web Bot Auth headers for one request, or null when the URL
// is not an http(s) request (nothing to sign).
function buildWebBotAuthHeaders(options: RequestHeaderOptions): Record<string, string> | null {
  const authority = authorityOf(options.url);
  if (authority === null) return null;
  if (!isHttpsUrl(options.directoryUrl)) throw new Error("web_bot_auth_directory_must_be_https");
  const label = options.label ?? SIGNATURE_LABEL;
  const created = options.created ?? toSeconds(options.now ?? Date.now());
  const expires = options.expires ?? created + clampTtl(options.ttlSeconds, DEFAULT_TTL_SECONDS, MAX_TTL_SECONDS);
  if (!Number.isInteger(created) || !Number.isInteger(expires) || created >= expires) throw new Error("web_bot_auth_invalid_validity");
  const nonce = options.nonce ?? randomBytes(NONCE_BYTES).toString("base64");
  const includeSignatureAgent = options.includeSignatureAgent !== false;
  const components = includeSignatureAgent ? COMPONENTS_WITH_AGENT : COMPONENTS_AUTHORITY_ONLY;
  const paramsValue = `${components};created=${created};keyid="${options.keyId}";alg="ed25519";expires=${expires};nonce="${nonce}";tag="${REQUEST_TAG}"`;
  const lines = [`"@authority": ${authority}`];
  if (includeSignatureAgent) lines.push(`"signature-agent": ${JSON.stringify(options.directoryUrl)}`);
  lines.push(`"@signature-params": ${paramsValue}`);
  const signature = signPayload(null, Buffer.from(lines.join("\n"), "utf8"), createPrivateKey(options.privateKeyPem)).toString("base64");
  const headers: Record<string, string> = {
    "Signature-Input": `${label}=${paramsValue}`,
    Signature: `${label}=:${signature}:`,
  };
  if (includeSignatureAgent) headers["Signature-Agent"] = JSON.stringify(options.directoryUrl);
  return headers;
}

function headerValue(headers: Record<string, unknown>, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target && typeof value === "string") return value;
  }
  return undefined;
}

interface VerifyOptions {
  url: string;
  headers: Record<string, unknown>;
  publicJwk: Ed25519PublicJwk;
  now?: number;
  clockSkewSeconds?: number;
}

// Verifies a signature produced by buildWebBotAuthHeaders (exact profile only).
// Used by the self-test tool and tests; runtime hosts do not depend on it.
function verifyWebBotAuthHeaders(options: VerifyOptions): boolean {
  const authority = authorityOf(options.url);
  if (authority === null) return false;
  const input = headerValue(options.headers, "signature-input");
  const signatureHeader = headerValue(options.headers, "signature");
  if (input === undefined || signatureHeader === undefined) return false;
  const parsed = /^([A-Za-z0-9_-]+)=\(("@authority" "signature-agent"|"@authority")\);created=(\d+);keyid="([^"]+)";alg="ed25519";expires=(\d+);nonce="([^"]+)";tag="web-bot-auth"$/.exec(input);
  if (parsed === null) return false;
  const [, label, components, createdRaw, keyId, expiresRaw, nonce] = parsed;
  const created = Number(createdRaw);
  const expires = Number(expiresRaw);
  const now = toSeconds(options.now ?? Date.now());
  const skew = options.clockSkewSeconds ?? CLOCK_SKEW_SECONDS;
  if (now + skew < created || now - skew > expires) return false;
  if (keyId !== jwkThumbprint(options.publicJwk)) return false;
  const includeSignatureAgent = components === `"@authority" "signature-agent"`;
  const lines = [`"@authority": ${authority}`];
  if (includeSignatureAgent) {
    const agent = headerValue(options.headers, "signature-agent");
    if (agent === undefined) return false;
    lines.push(`"signature-agent": ${agent}`);
  }
  lines.push(`"@signature-params": (${components});created=${created};keyid="${keyId}";alg="ed25519";expires=${expires};nonce="${nonce}";tag="web-bot-auth"`);
  const signature = new RegExp(`^${label}=:([A-Za-z0-9+/=]+):$`).exec(signatureHeader);
  if (signature === null) return false;
  try {
    return verifyPayload(null, Buffer.from(lines.join("\n"), "utf8"), createPublicKey({ key: options.publicJwk, format: "jwk" }), Buffer.from(signature[1], "base64"));
  } catch {
    return false;
  }
}

interface DirectoryVerifyOptions {
  directoryUrl?: string;
  authority?: string;
  headers: Record<string, unknown>;
  body: string;
  publicJwk: Ed25519PublicJwk;
  now?: number;
  clockSkewSeconds?: number;
}

// Verifies a key-directory HTTP response against one key from its own JWKS
// (draft-meunier-http-message-signatures-directory-03, section 5.2). The
// operator tool uses this to check a published directory before registration.
function verifyDirectoryResponse(options: DirectoryVerifyOptions): boolean {
  const authority = options.authority ?? (options.directoryUrl === undefined ? null : authorityOf(options.directoryUrl));
  if (authority === null) return false;
  const input = headerValue(options.headers, "signature-input");
  const signatureHeader = headerValue(options.headers, "signature");
  if (input === undefined || signatureHeader === undefined) return false;
  // Both published directory profiles are accepted: the draft/library form
  // that also signs the body digest, and the authority-only form the
  // Cloudflare reference server emits.
  const parsed = /^([A-Za-z0-9_-]+)=\(("@authority";req "content-digest"|"@authority";req)\);created=(\d+);keyid="([^"]+)";alg="ed25519";expires=(\d+)(?:;nonce="([^"]+)")?;tag="http-message-signatures-directory"$/.exec(input);
  if (parsed === null) return false;
  const [, label, components, createdRaw, keyId, expiresRaw, nonce] = parsed;
  const created = Number(createdRaw);
  const expires = Number(expiresRaw);
  const now = toSeconds(options.now ?? Date.now());
  const skew = options.clockSkewSeconds ?? CLOCK_SKEW_SECONDS;
  if (now + skew < created || now - skew > expires) return false;
  if (keyId !== jwkThumbprint(options.publicJwk)) return false;
  const usesDigest = components.includes("content-digest");
  const digestHeader = headerValue(options.headers, "content-digest");
  if (usesDigest) {
    if (digestHeader === undefined) return false;
    const digest = `sha-256=:${createHash("sha256").update(options.body).digest("base64")}:`;
    if (digest !== digestHeader) return false;
  }
  const noncePart = nonce === undefined ? "" : `;nonce="${nonce}"`;
  const lines = [`"@authority";req: ${authority}`];
  if (usesDigest) lines.push(`"content-digest": ${digestHeader}`);
  lines.push(`"@signature-params": (${components});created=${created};keyid="${keyId}";alg="ed25519";expires=${expires}${noncePart};tag="http-message-signatures-directory"`);
  const signature = new RegExp(`^${label}=:([A-Za-z0-9+/=]+):$`).exec(signatureHeader);
  if (signature === null) return false;
  try {
    return verifyPayload(null, Buffer.from(lines.join("\n"), "utf8"), createPublicKey({ key: options.publicJwk, format: "jwk" }), Buffer.from(signature[1], "base64"));
  } catch {
    return false;
  }
}

interface DirectoryResponseOptions {
  authority: string;
  keyId: string;
  privateKeyPem: string;
  body: string;
  now?: number;
  created?: number;
  expires?: number;
  nonce?: string;
  label?: string;
  ttlSeconds?: number;
}

// Signs a key-directory HTTP response (draft-meunier-http-message-signatures-
// directory-03, section 5.2). One call per key in the directory.
function buildDirectoryResponseHeaders(options: DirectoryResponseOptions): Record<string, string> {
  const label = options.label ?? DIRECTORY_LABEL;
  const created = options.created ?? toSeconds(options.now ?? Date.now());
  const expires = options.expires ?? created + clampTtl(options.ttlSeconds, DIRECTORY_TTL_SECONDS, 86400);
  if (!Number.isInteger(created) || !Number.isInteger(expires) || created >= expires) throw new Error("web_bot_auth_invalid_validity");
  const digest = `sha-256=:${createHash("sha256").update(options.body).digest("base64")}:`;
  const nonce = options.nonce === undefined ? "" : `;nonce="${options.nonce}"`;
  const paramsValue = `${DIRECTORY_COMPONENTS};created=${created};keyid="${options.keyId}";alg="ed25519";expires=${expires}${nonce};tag="${DIRECTORY_TAG}"`;
  const base = `"@authority";req: ${options.authority}\n"content-digest": ${digest}\n"@signature-params": ${paramsValue}`;
  const signature = signPayload(null, Buffer.from(base, "utf8"), createPrivateKey(options.privateKeyPem)).toString("base64");
  return {
    "Content-Digest": digest,
    "Signature-Input": `${label}=${paramsValue}`,
    Signature: `${label}=:${signature}:`,
  };
}

interface CreateSignerOptions {
  keyFile: string;
  directoryUrl: string;
  ttlSeconds?: number;
}

// One signer per install: loads (or creates) the local key and signs each
// request independently with a fresh nonce and a short expiry.
async function createRequestSigner(options: CreateSignerOptions): Promise<RequestSigner> {
  if (!isHttpsUrl(options.directoryUrl)) throw new Error("web_bot_auth_directory_must_be_https");
  const { privateKeyPem, publicJwk, keyId } = await loadOrCreateKey(options.keyFile);
  return {
    keyId,
    publicJwk,
    directoryJson: directoryBody(publicJwk, keyId),
    sign(url, overrides = {}) {
      return buildWebBotAuthHeaders({ url, directoryUrl: options.directoryUrl, keyId, privateKeyPem, ttlSeconds: options.ttlSeconds, ...overrides });
    },
  };
}

export = {
  DEFAULT_TTL_SECONDS,
  buildDirectoryResponseHeaders,
  buildWebBotAuthHeaders,
  createRequestSigner,
  directoryBody,
  isHttpsUrl,
  jwkThumbprint,
  loadOrCreateKey,
  verifyDirectoryResponse,
  verifyWebBotAuthHeaders,
};
