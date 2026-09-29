"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { LocalCredentialVault } = require("../main/harness/local-credential-vault");

const cipher = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value.split("").reverse().join(""), "utf8"),
  decryptString: (value) => Buffer.from(value).toString("utf8").split("").reverse().join(""),
};

async function withVault(run, safeStorage = cipher) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-vault-"));
  try { await run(new LocalCredentialVault({ storageRoot, safeStorage }), storageRoot); }
  finally { await fs.rm(storageRoot, { recursive: true, force: true }); }
}

test("vault encrypts secrets at rest and metadata listing omits password values", async () => {
  await withVault(async (vault, root) => {
    const saved = await vault.put({ origin: "https://example.com/login", username: "alice", password: "swordfish-secret", label: "Work" });
    assert.equal(saved.origin, "https://example.com");
    assert.equal("password" in saved, false);
    assert.equal(JSON.stringify(await vault.list()).includes("swordfish-secret"), false);
    assert.equal((await fs.readFile(path.join(root, "credentials.enc"))).includes(Buffer.from("swordfish-secret")), false);
    assert.deepEqual(await vault.list(), [saved]);
  });
});

test("vault rejects HTTP origins so credentials cannot be autofilled over cleartext transport", async () => {
  await withVault(async (vault, root) => {
    await assert.rejects(
      vault.put({ origin: "http://example.com/login", username: "alice", password: "secret" }),
      { code: "invalid_credential" },
    );
    await assert.rejects(fs.access(path.join(root, "credentials.enc")), { code: "ENOENT" });
  });
});

test("vault fill requires prior approval and exact origin; secrets are only passed to the trusted filler", async () => {
  await withVault(async (vault) => {
    const saved = await vault.put({ origin: "https://example.com", username: "alice", password: "swordfish-secret" });
    let received;
    const fill = (approved, origin) => vault.fill({
      credentialId: saved.id, origin, approved,
      fillCredential: async (values) => { received = values; return { status: "ok" }; },
    });
    await assert.rejects(fill(false, "https://example.com"), { code: "approval_required" });
    await assert.rejects(fill(true, "https://sub.example.com"), { code: "origin_mismatch" });
    assert.equal(received, undefined);
    assert.deepEqual(await fill(true, "https://example.com/path"), { status: "ok" });
    assert.deepEqual(received, { username: "alice", password: "swordfish-secret" });
  });
});

test("vault fails closed when secure storage is unavailable and never writes plaintext", async () => {
  await withVault(async (vault, root) => {
    await assert.rejects(vault.put({ origin: "https://example.com", username: "alice", password: "secret" }), { code: "encryption_unavailable" });
    await assert.rejects(fs.access(path.join(root, "credentials.enc")), { code: "ENOENT" });
  }, { isEncryptionAvailable: () => false });
});

test("vault refuses Electron's basic_text fallback backend", async () => {
  await withVault(async (vault, root) => {
    await assert.rejects(vault.put({ origin: "https://example.com", username: "alice", password: "secret" }), { code: "encryption_unavailable" });
    await assert.rejects(fs.access(path.join(root, "credentials.enc")), { code: "ENOENT" });
  }, { ...cipher, getSelectedStorageBackend: () => "basic_text" });
});
