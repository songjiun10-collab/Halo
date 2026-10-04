"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { SessionVault } = require("../main/harness/profile-import/session-vault");

const cipher = {
  isEncryptionAvailable: () => true,
  encryptString: (v) => Buffer.from(v.split("").reverse().join(""), "utf8"),
  decryptString: (v) => Buffer.from(v).toString("utf8").split("").reverse().join(""),
};
const cookie = (over = {}) => ({ domain: ".claude.ai", name: "sessionKey", value: "sk-secret-value", path: "/", secure: true, httpOnly: true, sameSite: "lax", expires: 1_900_000_000, ...over });

async function withVault(run, opts = {}) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-sessions-"));
  try { await run(new SessionVault({ storageRoot, safeStorage: cipher, now: () => "2026-09-30T00:00:00.000Z", ...opts }), storageRoot); }
  finally { await fs.rm(storageRoot, { recursive: true, force: true }); }
}

test("stores cookies encrypted at rest and lists metadata without values", async () => {
  await withVault(async (vault, root) => {
    await vault.replaceFromImport({ source: "chrome", cookies: [cookie(), cookie({ domain: "chatgpt.com", name: "tok", value: "gpt-secret" })] });
    const list = await vault.listSessions();
    assert.deepEqual(list.map((s) => [s.domain, s.cookieCount, s.source]).sort(), [["chatgpt.com", 1, "chrome"], ["claude.ai", 1, "chrome"]]);
    assert.equal(JSON.stringify(list).includes("secret"), false);
    const raw = await fs.readFile(path.join(root, "sessions.enc"));
    assert.equal(raw.includes(Buffer.from("sk-secret-value")), false);
    assert.equal(raw.includes(Buffer.from("gpt-secret")), false);
  });
});

test("cookiesFor returns only live cookies for the requested allowlisted domains", async () => {
  await withVault(async (vault) => {
    await vault.replaceFromImport({ source: "chrome", cookies: [cookie(), cookie({ name: "old", expires: 1_000_000_000 }), cookie({ domain: "chatgpt.com", name: "tok", expires: null })] });
    const got = await vault.cookiesFor({ domains: ["claude.ai"], nowSeconds: 1_800_000_000 });
    assert.deepEqual(got.map((c) => c.name), ["sessionKey"]);
    assert.equal(got[0].value, "sk-secret-value");
    assert.deepEqual(await vault.cookiesFor({ domains: [], nowSeconds: 1_800_000_000 }), []);
  });
});

test("re-import replaces only the imported domains and remove deletes one domain", async () => {
  await withVault(async (vault) => {
    await vault.replaceFromImport({ source: "chrome", cookies: [cookie(), cookie({ domain: "chatgpt.com", name: "tok" })] });
    await vault.replaceFromImport({ source: "safari", cookies: [cookie({ name: "new", value: "v2" })] });
    const claude = await vault.cookiesFor({ domains: ["claude.ai"], nowSeconds: 1 });
    assert.deepEqual(claude.map((c) => c.name), ["new"]);
    assert.equal((await vault.cookiesFor({ domains: ["chatgpt.com"], nowSeconds: 1 })).length, 1);
    assert.equal(await vault.removeDomain("chatgpt.com"), true);
    assert.equal(await vault.removeDomain("chatgpt.com"), false);
    assert.deepEqual((await vault.listSessions()).map((s) => s.domain), ["claude.ai"]);
  });
});

test("fails closed when encryption is unavailable and writes no plaintext", async () => {
  await withVault(async (vault, root) => {
    await assert.rejects(vault.replaceFromImport({ source: "chrome", cookies: [cookie()] }), { code: "encryption_unavailable" });
    await assert.rejects(fs.access(path.join(root, "sessions.enc")), { code: "ENOENT" });
  }, { safeStorage: { ...cipher, isEncryptionAvailable: () => false } });
  await withVault(async (vault) => {
    await assert.rejects(vault.replaceFromImport({ source: "chrome", cookies: [cookie()] }), { code: "encryption_unavailable" });
  }, { safeStorage: { ...cipher, getSelectedStorageBackend: () => "basic_text" } });
});

test("rejects malformed cookies, oversize batches and unknown sources", async () => {
  await withVault(async (vault) => {
    await assert.rejects(vault.replaceFromImport({ source: "firefox", cookies: [cookie()] }), { code: "invalid_session" });
    await assert.rejects(vault.replaceFromImport({ source: "chrome", cookies: [cookie({ name: "" })] }), { code: "invalid_session" });
    await assert.rejects(vault.replaceFromImport({ source: "chrome", cookies: [cookie({ value: "x".repeat(5000) })] }), { code: "invalid_session" });
    await assert.rejects(vault.replaceFromImport({ source: "chrome", cookies: [cookie({ extra: 1 })] }), { code: "invalid_session" });
    await assert.rejects(vault.replaceFromImport({ source: "chrome", cookies: Array.from({ length: 501 }, (_, i) => cookie({ name: `c${i}` })) }), { code: "vault_limit" });
  });
});

test("a corrupt vault file fails closed", async () => {
  await withVault(async (vault, root) => {
    await vault.replaceFromImport({ source: "chrome", cookies: [cookie()] });
    await fs.writeFile(path.join(root, "sessions.enc"), Buffer.from("not-json-reversed"));
    await assert.rejects(vault.listSessions(), { code: "vault_corrupt" });
  });
});

test("replaceFromImport keeps the stored copy of a row the reader could not decrypt, and replaces everything else", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "halo-vault-preserve-"));
  try {
    const vault = new SessionVault({ storageRoot: root, safeStorage: cipher });
    await vault.replaceFromImport({ source: "chrome", replaceDomains: ["claude.ai"], cookies: [
      cookie({ name: "keep-me", value: "old-keep" }), cookie({ name: "refresh-me", value: "old" }), cookie({ name: "gone", value: "old-gone" }),
    ] });
    const outcome = await vault.replaceFromImport({
      source: "chrome", replaceDomains: ["claude.ai"],
      cookies: [cookie({ name: "refresh-me", value: "new" })],
      preserve: [{ domain: ".claude.ai", name: "keep-me", path: "/" }],
    });
    assert.deepEqual(outcome, { imported: 1, preserved: 1 });
    const stored = await vault.cookiesFor({ domains: ["claude.ai"], nowSeconds: 1 });
    assert.deepEqual(stored.map((c) => `${c.name}=${c.value}`).sort(), ["keep-me=old-keep", "refresh-me=new"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("without a preserve list an import still replaces the whole allowlisted domain", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "halo-vault-replace-"));
  try {
    const vault = new SessionVault({ storageRoot: root, safeStorage: cipher });
    await vault.replaceFromImport({ source: "chrome", replaceDomains: ["claude.ai"], cookies: [cookie({ name: "a" }), cookie({ name: "b" })] });
    const outcome = await vault.replaceFromImport({ source: "chrome", replaceDomains: ["claude.ai"], cookies: [cookie({ name: "b", value: "n" })] });
    assert.deepEqual(outcome, { imported: 1, preserved: 0 });
    assert.deepEqual((await vault.cookiesFor({ domains: ["claude.ai"], nowSeconds: 1 })).map((c) => c.name), ["b"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
