"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { ProfileImporter, SessionConfigStore, DEFAULT_ALLOWLIST } = require("../main/harness/profile-import/profile-importer");
const { SessionVault } = require("../main/harness/profile-import/session-vault");

const cipher = {
  isEncryptionAvailable: () => true,
  encryptString: (v) => Buffer.from(v.split("").reverse().join(""), "utf8"),
  decryptString: (v) => Buffer.from(v).toString("utf8").split("").reverse().join(""),
};
const cookie = (over = {}) => ({ domain: ".claude.ai", name: "sessionKey", value: "sk-secret", path: "/", secure: true, httpOnly: true, sameSite: "lax", expires: null, ...over });

async function withImporter(run, { readChrome } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "halo-importer-"));
  try {
    const vault = new SessionVault({ storageRoot: root, safeStorage: cipher });
    const config = new SessionConfigStore({ storageRoot: root });
    const calls = [];
    const importer = new ProfileImporter({ vault, config, readers: { chrome: readChrome || (async (o) => { calls.push(o); return { status: "ok", cookies: [cookie(), cookie({ domain: "chatgpt.com", name: "t", value: "gpt-secret" })] }; }) } });
    await run({ importer, vault, config, calls, root });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("allowlist defaults to claude.ai and chatgpt.com, is validated and persists", async () => {
  await withImporter(async ({ config, root }) => {
    assert.deepEqual(await config.getAllowlist(), DEFAULT_ALLOWLIST);
    assert.deepEqual(DEFAULT_ALLOWLIST, ["claude.ai", "chatgpt.com"]);
    assert.deepEqual(await config.setAllowlist([".Claude.ai", "example.org", "example.org"]), ["claude.ai", "example.org"]);
    assert.deepEqual(await new SessionConfigStore({ storageRoot: root }).getAllowlist(), ["claude.ai", "example.org"]);
    await assert.rejects(config.setAllowlist(["localhost"]), { code: "invalid_config" });
    await assert.rejects(config.setAllowlist(["http://claude.ai"]), { code: "invalid_config" });
    await assert.rejects(config.setAllowlist(Array.from({ length: 21 }, (_, i) => `site${i}.com`)), { code: "invalid_config" });
    await assert.rejects(config.setAllowlist("claude.ai"), { code: "invalid_config" });
  });
});

test("opt-in is recorded per task and persists", async () => {
  await withImporter(async ({ config, root }) => {
    assert.equal(await config.hasOptIn("t1"), false);
    await config.addOptIn("t1");
    assert.equal(await config.hasOptIn("t1"), true);
    assert.equal(await new SessionConfigStore({ storageRoot: root }).hasOptIn("t1"), true);
    assert.equal(await config.hasOptIn("t2"), false);
    await assert.rejects(config.addOptIn(""), { code: "invalid_config" });
  });
});

test("import reads with the current allowlist, stores cookies and returns no values", async () => {
  await withImporter(async ({ importer, vault, calls }) => {
    const result = await importer.import({ browser: "chrome", profile: "Default" });
    assert.deepEqual(calls[0].domains, ["claude.ai", "chatgpt.com"]);
    assert.equal(calls[0].profile, "Default");
    assert.deepEqual(result, { status: "ok", imported: 2, browser: "chrome" });
    assert.equal(JSON.stringify(result).includes("secret"), false);
    assert.equal((await importer.list()).length, 2);
    assert.equal((await vault.cookiesFor({ domains: ["claude.ai"], nowSeconds: 1 }))[0].value, "sk-secret");
  });
});

test("reader failures pass through as structured status and never touch the vault", async () => {
  for (const status of ["permission_required", "not_found", "decrypt_failed", "locked"]) {
    await withImporter(async ({ importer }) => {
      await importer.import({ browser: "chrome" }).then((r) => assert.deepEqual(r, { status, imported: 0, browser: "chrome" }));
      assert.deepEqual(await importer.list(), []);
    }, { readChrome: async () => ({ status, cookies: [] }) });
  }
});

test("a failed re-import keeps the existing sessions", async () => {
  let ok = true;
  await withImporter(async ({ importer }) => {
    await importer.import({ browser: "chrome" });
    ok = false;
    assert.equal((await importer.import({ browser: "chrome" })).status, "locked");
    assert.deepEqual((await importer.list()).map((s) => s.domain), ["claude.ai"]);
  }, { readChrome: async () => ok ? { status: "ok", cookies: [cookie()] } : { status: "locked", cookies: [] } });
});

test("re-import that finds no cookies for an allowlisted domain clears that domain", async () => {
  let cookies = [cookie(), cookie({ domain: "chatgpt.com", name: "t" })];
  await withImporter(async ({ importer }) => {
    await importer.import({ browser: "chrome" });
    cookies = [cookie()];
    await importer.import({ browser: "chrome" });
    assert.deepEqual((await importer.list()).map((s) => s.domain), ["claude.ai"]);
  }, { readChrome: async () => ({ status: "ok", cookies }) });
});

test("safari is reported unsupported and unknown browsers are rejected", async () => {
  await withImporter(async ({ importer }) => {
    assert.deepEqual(await importer.import({ browser: "safari" }), { status: "unsupported", imported: 0, browser: "safari" });
    await assert.rejects(importer.import({ browser: "firefox" }), { code: "invalid_config" });
  });
});

test("prepareTask injects only for opted-in tasks and returns a value-free summary", async () => {
  await withImporter(async ({ importer, config }) => {
    await importer.import({ browser: "chrome" });
    const set = [];
    const session = { cookies: { set: async (d) => { set.push(d); } } };
    assert.equal(await importer.prepareTask("t-no", session), null);
    assert.equal(set.length, 0);
    await config.addOptIn("t-yes");
    const summary = await importer.prepareTask("t-yes", session);
    assert.deepEqual(summary, { injected: 2, failed: 0, domains: ["claude.ai", "chatgpt.com"] });
    assert.equal(set.length, 2);
  });
});

test("removing a domain deletes its sessions", async () => {
  await withImporter(async ({ importer }) => {
    await importer.import({ browser: "chrome" });
    assert.equal(await importer.remove("claude.ai"), true);
    assert.deepEqual((await importer.list()).map((s) => s.domain), ["chatgpt.com"]);
  });
});

test("importSettings stores non-secret settings and reports counts; get returns them", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "halo-importer-"));
  try {
    const settings = { status: "ok", bookmarks: [{ folder: "Bar", title: "A", url: "https://a.example/" }], searchEngines: [{ name: "G", keyword: "g", url: "https://g.example/?q={searchTerms}" }], homepage: { url: "https://h.example/", useNewTab: false }, startupUrls: ["https://s.example/"] };
    const importer = new ProfileImporter({
      vault: new SessionVault({ storageRoot: root, safeStorage: cipher }), config: new SessionConfigStore({ storageRoot: root }),
      readers: {}, settingsReaders: { chrome: async () => settings },
    });
    assert.deepEqual(await importer.getSettings(), null);
    assert.deepEqual(await importer.importSettings({ browser: "chrome" }), { status: "ok", browser: "chrome", bookmarks: 1, searchEngines: 1, startupUrls: 1, homepage: true });
    const stored = await importer.getSettings();
    assert.equal(stored.browser, "chrome");
    assert.deepEqual(stored.bookmarks, settings.bookmarks);
    assert.equal(typeof stored.importedAt, "string");
    assert.deepEqual(await importer.importSettings({ browser: "safari" }), { status: "unsupported", browser: "safari", bookmarks: 0, searchEngines: 0, startupUrls: 0, homepage: false });
    await assert.rejects(importer.importSettings({ browser: "firefox" }), { code: "invalid_config" });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a failed settings import keeps the previously stored settings", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "halo-importer-"));
  try {
    let status = "ok";
    const importer = new ProfileImporter({
      vault: new SessionVault({ storageRoot: root, safeStorage: cipher }), config: new SessionConfigStore({ storageRoot: root }),
      readers: {}, settingsReaders: { chrome: async () => ({ status, bookmarks: status === "ok" ? [{ folder: "F", title: "T", url: "https://t.example/" }] : [], searchEngines: [], homepage: null, startupUrls: [] }) },
    });
    await importer.importSettings({ browser: "chrome" });
    status = "not_found";
    assert.equal((await importer.importSettings({ browser: "chrome" })).status, "not_found");
    assert.equal((await importer.getSettings()).bookmarks.length, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
