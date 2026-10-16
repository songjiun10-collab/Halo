"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ApiKeyStore } = require("../main/harness/api-key-store");
const { plannerProviderEnv, selectPlannerLaunch } = require("../main/harness/planner-providers");

const cipher = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(value.split("").reverse().join(""), "utf8"),
  decryptString: (value) => Buffer.from(value).toString("utf8").split("").reverse().join(""),
};

async function withStore(run, safeStorage = cipher) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-keys-"));
  try { await run(storageRoot, () => new ApiKeyStore({ storageRoot, safeStorage })); }
  finally { await fs.rm(storageRoot, { recursive: true, force: true }); }
}

test("keys are encrypted at rest, reported as presence only, and survive a restart", async () => {
  await withStore(async (root, open) => {
    const store = open();
    assert.deepEqual(await store.set("nvidia", "  nvapi-secret-123  "), { antigravity: false, cursor: false, nvidia: true });
    assert.equal((await fs.readFile(path.join(root, "api-keys.enc"))).includes(Buffer.from("nvapi-secret-123")), false);
    assert.deepEqual(store.env(), { NVIDIA_API_KEY: "nvapi-secret-123" });
    const reopened = open();
    await reopened.load();
    assert.deepEqual(reopened.env(), { NVIDIA_API_KEY: "nvapi-secret-123" });
    assert.deepEqual(await reopened.clear("nvidia"), { antigravity: false, cursor: false, nvidia: false });
    assert.deepEqual(reopened.env(), {})
  });
});

test("rejects unknown providers, blank or multi-word keys, and unavailable encryption", async () => {
  await withStore(async (_root, open) => {
    const store = open();
    await assert.rejects(store.set("claude_code", "abc123abc"), { code: "invalid_provider" });
    await assert.rejects(store.set("cursor", "   "), { code: "invalid_key" });
    await assert.rejects(store.set("cursor", "two words"), { code: "invalid_key" });
    await assert.rejects(store.set("cursor", "x".repeat(600)), { code: "invalid_key" });
  });
  await withStore(async (_root, open) => {
    await assert.rejects(open().set("cursor", "abc123abc"), { code: "encryption_unavailable" });
  }, { ...cipher, isEncryptionAvailable: () => false });
});

test("a registered key reaches only its own planner worker, and the process environment wins", () => {
  const launch = selectPlannerLaunch({ providerId: "cursor", nodeCommand: "node" });
  assert.deepEqual(plannerProviderEnv(launch, { CURSOR_API_KEY: "stored-key", GEMINI_API_KEY: "other" }), { CURSOR_API_KEY: "stored-key" });
  assert.deepEqual(plannerProviderEnv(launch, { ...{ CURSOR_API_KEY: "stored" }, ...{ CURSOR_API_KEY: "from-env" } }), { CURSOR_API_KEY: "from-env" });
});
