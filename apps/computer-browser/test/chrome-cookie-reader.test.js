"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const { readChromeCookies, domainMatches, decryptChromeValue } = require("../main/harness/profile-import/chrome-cookie-reader");
const { ProfileImporter, SessionConfigStore } = require("../main/harness/profile-import/profile-importer");
const { SessionVault } = require("../main/harness/profile-import/session-vault");

const PASSWORD = "test-keychain-password";
const key = crypto.pbkdf2Sync(PASSWORD, "saltysalt", 1003, 16, "sha1");

function encrypt(plaintext, { hostKey, hashPrefix }) {
  const body = Buffer.concat([hashPrefix ? crypto.createHash("sha256").update(hostKey).digest() : Buffer.alloc(0), Buffer.from(plaintext, "utf8")]);
  const cipher = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from("v10"), cipher.update(body), cipher.final()]);
}

async function makeProfile(rows, { version = 24, network = true } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "halo-chrome-"));
  const dir = network ? path.join(root, "Default", "Network") : path.join(root, "Default");
  await fs.mkdir(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, "Cookies"));
  db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)");
  db.prepare("INSERT INTO meta VALUES ('version', ?)").run(String(version));
  db.exec(`CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
    expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER)`);
  const insert = db.prepare("INSERT INTO cookies VALUES (?,?,?,?,?,?,?,?,?)");
  for (const r of rows) insert.run(r.host, r.name, r.value ?? "", r.enc ?? Buffer.alloc(0), r.path ?? "/", r.expires ?? 0, r.secure ?? 1, r.httpOnly ?? 1, r.sameSite ?? -1);
  db.close();
  return root;
}

const opts = (root, extra = {}) => ({
  chromeRoot: root, profile: "Default", domains: ["claude.ai", "chatgpt.com"],
  getSafeStoragePassword: async () => PASSWORD, now: () => 1_800_000_000_000, ...extra,
});

test("domainMatches only accepts the exact registrable domain and its subdomains", () => {
  assert.equal(domainMatches(".claude.ai", ["claude.ai"]), true);
  assert.equal(domainMatches("claude.ai", ["claude.ai"]), true);
  assert.equal(domainMatches("api.claude.ai", ["claude.ai"]), true);
  assert.equal(domainMatches("evilclaude.ai", ["claude.ai"]), false);
  assert.equal(domainMatches("claude.ai.evil.com", ["claude.ai"]), false);
  assert.equal(domainMatches(".google.com", ["claude.ai"]), false);
});

test("decryptChromeValue strips the v24 host hash and rejects a tampered hash", () => {
  const enc = encrypt("secret-token", { hostKey: ".claude.ai", hashPrefix: true });
  assert.equal(decryptChromeValue(enc, { key, hostKey: ".claude.ai", hasHashPrefix: true }), "secret-token");
  assert.equal(decryptChromeValue(enc, { key, hostKey: ".other.com", hasHashPrefix: true }), null);
  const legacy = encrypt("old-token", { hostKey: ".claude.ai", hashPrefix: false });
  assert.equal(decryptChromeValue(legacy, { key, hostKey: ".claude.ai", hasHashPrefix: false }), "old-token");
  assert.equal(decryptChromeValue(Buffer.from("garbage"), { key, hostKey: ".x", hasHashPrefix: false }), null);
});

test("reads only allowlisted cookies, decrypts them and maps Chrome fields", async () => {
  const root = await makeProfile([
    { host: ".claude.ai", name: "sessionKey", enc: encrypt("sk-live", { hostKey: ".claude.ai", hashPrefix: true }), expires: (1_900_000_000 + 11644473600) * 1e6, sameSite: 1 },
    { host: "chatgpt.com", name: "__Secure-next-auth", enc: encrypt("gpt-live", { hostKey: "chatgpt.com", hashPrefix: true }), sameSite: 2, secure: 1 },
    { host: ".google.com", name: "SID", enc: encrypt("google-secret", { hostKey: ".google.com", hashPrefix: true }) },
    { host: "evilclaude.ai", name: "x", enc: encrypt("nope", { hostKey: "evilclaude.ai", hashPrefix: true }) },
  ]);
  try {
    const result = await readChromeCookies(opts(root));
    assert.equal(result.status, "ok");
    assert.deepEqual(result.cookies.map((c) => `${c.domain}|${c.name}|${c.value}`).sort(), [".claude.ai|sessionKey|sk-live", "chatgpt.com|__Secure-next-auth|gpt-live"]);
    const claude = result.cookies.find((c) => c.name === "sessionKey");
    assert.equal(claude.sameSite, "lax");
    assert.equal(claude.expires, 1_900_000_000);
    assert.equal(claude.secure && claude.httpOnly, true);
    assert.equal(result.cookies.find((c) => c.name === "__Secure-next-auth").sameSite, "strict");
    assert.equal(result.cookies.find((c) => c.name === "__Secure-next-auth").expires, null);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("partial Chrome cookie decryption is reported through ProfileImporter without exposing values", async () => {
  const root = await makeProfile([
    { host: ".claude.ai", name: "session-good", enc: encrypt("good-cookie", { hostKey: ".claude.ai", hashPrefix: true }) },
    { host: ".claude.ai", name: "session-skipped", enc: encrypt("bad-cookie", { hostKey: ".wrong-domain", hashPrefix: true }) },
  ]);
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-partial-import-"));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value.split("").reverse().join(""), "utf8"),
    decryptString: (value) => Buffer.from(value).toString("utf8").split("").reverse().join(""),
  };
  try {
    const vault = new SessionVault({ storageRoot, safeStorage });
    const importer = new ProfileImporter({
      vault,
      config: new SessionConfigStore({ storageRoot }),
      readers: { chrome: ({ domains, profile }) => readChromeCookies({ ...opts(root), domains, profile }) },
    });

    const result = await importer.import({ browser: "chrome", profile: "Default" });
    assert.deepEqual(result, { status: "partial", imported: 1, skipped: 1, browser: "chrome" });
    assert.equal(JSON.stringify(result).includes("good-cookie"), false);
    const sessions = await importer.list();
    assert.deepEqual(sessions.map(({ domain, cookieCount }) => ({ domain, cookieCount })), [{ domain: "claude.ai", cookieCount: 1 }]);
    assert.equal((await vault.cookiesFor({ domains: ["claude.ai"], nowSeconds: 1 }))[0].value, "good-cookie");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(storageRoot, { recursive: true, force: true });
  }
});

test("skips expired cookies and works on the legacy path and pre-v24 layout", async () => {
  const root = await makeProfile([
    { host: ".claude.ai", name: "old", enc: encrypt("v", { hostKey: ".claude.ai", hashPrefix: false }), expires: (1_000_000_000 + 11644473600) * 1e6 },
    { host: ".claude.ai", name: "live", enc: encrypt("v2", { hostKey: ".claude.ai", hashPrefix: false }) },
  ], { version: 20, network: false });
  try {
    const result = await readChromeCookies(opts(root));
    assert.deepEqual(result.cookies.map((c) => c.name), ["live"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("reports structured failures without throwing or leaking values", async () => {
  const empty = await fs.mkdtemp(path.join(os.tmpdir(), "halo-chrome-"));
  try {
    assert.deepEqual(await readChromeCookies(opts(empty)), { status: "not_found", cookies: [] });
    const root = await makeProfile([{ host: ".claude.ai", name: "s", enc: encrypt("v", { hostKey: ".claude.ai", hashPrefix: true }) }]);
    try {
      const denied = await readChromeCookies(opts(root, { getSafeStoragePassword: async () => { throw new Error("user denied keychain"); } }));
      assert.equal(denied.status, "permission_required");
      assert.deepEqual(denied.cookies, []);
      const wrong = await readChromeCookies(opts(root, { getSafeStoragePassword: async () => "wrong-password" }));
      assert.equal(wrong.status, "decrypt_failed");
      assert.deepEqual(wrong.cookies, []);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  } finally { await fs.rm(empty, { recursive: true, force: true }); }
});

test("rejects unsafe profile names and empty allowlists", async () => {
  const root = await makeProfile([]);
  try {
    await assert.rejects(readChromeCookies(opts(root, { profile: "../../etc" })), { code: "invalid_config" });
    await assert.rejects(readChromeCookies(opts(root, { domains: [] })), { code: "invalid_config" });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("does not modify or leave copies of the source database", async () => {
  const root = await makeProfile([{ host: ".claude.ai", name: "s", enc: encrypt("v", { hostKey: ".claude.ai", hashPrefix: true }) }]);
  const source = path.join(root, "Default", "Network", "Cookies");
  const before = await fs.readFile(source);
  const tmpBefore = (await fs.readdir(os.tmpdir())).filter((n) => n.startsWith("halo-chrome-cookies-")).length;
  try {
    await readChromeCookies(opts(root));
    assert.deepEqual(await fs.readFile(source), before);
    assert.equal((await fs.readdir(os.tmpdir())).filter((n) => n.startsWith("halo-chrome-cookies-")).length, tmpBefore);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
