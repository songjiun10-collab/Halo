"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { LocalMemoryStore } = require("../main/harness/local-memory-store");

function testCipher() {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value) => Buffer.from(value.split("").reverse().join(""), "utf8"),
    decryptString: (value) => Buffer.from(value).toString("utf8").split("").reverse().join(""),
  };
}

async function withStore(run, overrides = {}) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-memory-"));
  try {
    await run(new LocalMemoryStore({ storageRoot, safeStorage: testCipher(), ...overrides }), storageRoot);
  } finally {
    await fs.rm(storageRoot, { recursive: true, force: true });
  }
}

test("custom memory is encrypted at rest and survives store restart", async () => {
  await withStore(async (store, root) => {
    const entry = await store.put({ text: "Use compact reports" });
    const filePath = path.join(root, "custom-memory.enc");
    const bytes = await fs.readFile(filePath);
    assert.equal(bytes.includes(Buffer.from("Use compact reports")), false);
    assert.deepEqual(await new LocalMemoryStore({ storageRoot: root, safeStorage: testCipher() }).list(), [entry]);
    assert.equal((await fs.stat(filePath)).mode & 0o777, 0o600);
  });
});

test("memory context includes global and exact-origin records in stable order", async () => {
  await withStore(async (store) => {
    const global = await store.put({ text: "Global preference" });
    const scoped = await store.put({ text: "This site preference", origin: "https://example.com/path" });
    await store.put({ text: "Other site", origin: "https://other.example" });
    const result = await store.forContext("https://example.com/account");
    assert.deepEqual(result.entries.map((entry) => entry.id), [global.id, scoped.id]);
    assert.equal(result.overflow, false);
  });
});

test("memory context fails explicitly when selected records exceed its byte budget", async () => {
  await withStore(async (store) => {
    await store.put({ text: "x".repeat(100) });
    await assert.rejects(store.forContext("https://example.com"), { code: "memory_context_overflow" });
  }, { maxContextBytes: 30 });
});

test("memory CRUD validates bounds and does not persist after encryption is unavailable", async () => {
  await withStore(async (store) => {
    await assert.rejects(store.put({ text: "" }), { code: "invalid_memory_entry" });
    const entry = await store.put({ text: "Delete me" });
    assert.equal(await store.remove(entry.id), true);
    assert.deepEqual(await store.list(), []);
  });
  await withStore(async (store, root) => {
    await assert.rejects(store.put({ text: "must not persist" }), { code: "encryption_unavailable" });
    await assert.rejects(fs.access(path.join(root, "custom-memory.enc")), { code: "ENOENT" });
  }, { safeStorage: { isEncryptionAvailable: () => false } });
});

test("custom memory refuses Electron's basic_text fallback backend", async () => {
  await withStore(async (store, root) => {
    await assert.rejects(store.put({ text: "must not persist" }), { code: "encryption_unavailable" });
    await assert.rejects(fs.access(path.join(root, "custom-memory.enc")), { code: "ENOENT" });
  }, { safeStorage: { ...testCipher(), getSelectedStorageBackend: () => "basic_text" } });
});
