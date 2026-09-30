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

test("the allowlist rejects public and private suffixes but accepts a registrable domain beneath them", async () => {
  await withImporter(async ({ config }) => {
    for (const bad of ["co.uk", "github.io", "com", "herokuapp.com"]) {
      await assert.rejects(config.setAllowlist([bad]), { code: "invalid_config" }, bad);
    }
    assert.deepEqual(await config.setAllowlist(["claude.ai", "victim.github.io", "shop.co.uk"]), ["claude.ai", "victim.github.io", "shop.co.uk"]);
  });
});

test("an allowlist saved by an older build that contains a public suffix is narrowed on read, not trusted", async () => {
  await withImporter(async ({ config, root }) => {
    await fs.writeFile(path.join(root, "session-config.json"), JSON.stringify({ allowlist: ["co.uk", "claude.ai", "github.io"], optIn: [] }));
    assert.deepEqual(await config.getAllowlist(), ["claude.ai"]);
  });
});

function fakeTaskSession(initial) {
  const removed = [];
  const cookies = [...initial];
  return {
    removed,
    cookies: {
      set: async (details) => { cookies.push({ domain: details.domain || new URL(details.url).hostname, name: details.name, path: details.path || "/", secure: details.secure }); },
      get: async () => [...cookies],
      remove: async (url, name) => { removed.push([url, name]); const i = cookies.findIndex((c) => c.name === name); if (i >= 0) cookies.splice(i, 1); },
    },
  };
}

test("removing a domain also purges its cookies from running task sessions, and only that domain", async () => {
  await withImporter(async ({ importer, config }) => {
    await importer.import({ browser: "chrome" });
    await config.addOptIn("task-1");
    const session = fakeTaskSession([{ domain: ".other.example", name: "unrelated", path: "/", secure: true }]);
    await importer.prepareTask("task-1", session);
    assert.equal((await session.cookies.get()).some((c) => c.name === "sessionKey"), true, "injected before removal");

    assert.equal(await importer.remove("claude.ai"), true);
    assert.deepEqual(session.removed, [["https://claude.ai/", "sessionKey"]]);
    const remaining = (await session.cookies.get()).map((c) => c.name).sort();
    assert.deepEqual(remaining, ["t", "unrelated"], "chatgpt.com and unrelated cookies are untouched");
  });
});

test("a released task session is no longer touched by a later removal", async () => {
  await withImporter(async ({ importer, config }) => {
    await importer.import({ browser: "chrome" });
    await config.addOptIn("task-1");
    const session = fakeTaskSession([]);
    await importer.prepareTask("task-1", session);
    importer.releaseTask("task-1");
    await importer.remove("claude.ai");
    assert.deepEqual(session.removed, []);
  });
});

test("if a live session cannot be purged the removal is reported, not swallowed, and other sessions are still purged", async () => {
  await withImporter(async ({ importer, config }) => {
    await importer.import({ browser: "chrome" });
    await config.addOptIn("bad");
    await config.addOptIn("good");
    const broken = { cookies: { set: async () => {}, get: async () => { throw new Error("session destroyed"); }, remove: async () => {} } };
    const healthy = fakeTaskSession([]);
    await importer.prepareTask("bad", broken);
    await importer.prepareTask("good", healthy);
    await assert.rejects(importer.remove("claude.ai"), { code: "purge_incomplete" });
    assert.deepEqual(healthy.removed, [["https://claude.ai/", "sessionKey"]]);
    assert.equal((await importer.list()).some((s) => s.domain === "claude.ai"), false, "the vault record is gone regardless");
  });
});

test("a partial decrypt keeps the previously stored copies of the failed rows and reports the partial status", async () => {
  let call = 0;
  const readChrome = async () => {
    call += 1;
    if (call === 1) return { status: "ok", cookies: [cookie({ name: "a", value: "old-a" }), cookie({ name: "b", value: "old-b" })], skipped: 0, failed: [] };
    return { status: "ok", cookies: [cookie({ name: "a", value: "new-a" })], skipped: 1, failed: [{ domain: ".claude.ai", name: "b", path: "/" }] };
  };
  await withImporter(async ({ importer, vault }) => {
    assert.deepEqual(await importer.import({ browser: "chrome" }), { status: "ok", imported: 2, browser: "chrome" });
    assert.deepEqual(await importer.import({ browser: "chrome" }), { status: "partial", imported: 1, browser: "chrome", skipped: 1 });
    const stored = await vault.cookiesFor({ domains: ["claude.ai"], nowSeconds: 1 });
    assert.deepEqual(stored.map((c) => `${c.name}=${c.value}`).sort(), ["a=new-a", "b=old-b"]);
  }, { readChrome });
});

test("partitioned cookies that the reader excluded are reported by count without changing the status", async () => {
  const readChrome = async () => ({ status: "ok", cookies: [cookie()], skipped: 0, failed: [], partitioned: 3 });
  await withImporter(async ({ importer }) => {
    assert.deepEqual(await importer.import({ browser: "chrome" }), { status: "ok", imported: 1, browser: "chrome", partitioned: 3 });
  }, { readChrome });
});

test("a settings section that could not be read keeps its previously imported value and the import is partial", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "halo-importer-settings-"));
  try {
    let response;
    const config = new SessionConfigStore({ storageRoot: root });
    const importer = new ProfileImporter({
      vault: new SessionVault({ storageRoot: root, safeStorage: cipher }), config, readers: {},
      settingsReaders: { chrome: async () => response },
    });
    response = { status: "ok", bookmarks: [{ folder: "", title: "Keep", url: "https://keep.example/" }], searchEngines: [], homepage: { url: "https://home.example/", useNewTab: false }, startupUrls: [] };
    assert.equal((await importer.importSettings({ browser: "chrome" })).status, "ok");

    response = { status: "ok", bookmarks: [], searchEngines: [{ name: "S", keyword: "s", url: "https://s.example/?q={searchTerms}" }], homepage: null, startupUrls: [], failed: ["bookmarks", "preferences"] };
    const result = await importer.importSettings({ browser: "chrome" });
    assert.equal(result.status, "partial");
    assert.deepEqual(result.failed, ["bookmarks", "preferences"]);
    const stored = await importer.getSettings();
    assert.equal(stored.bookmarks.length, 1, "bookmarks were preserved");
    assert.equal(stored.homepage.url, "https://home.example/", "homepage was preserved");
    assert.equal(stored.searchEngines.length, 1, "the readable section was updated");

    response = { status: "ok", bookmarks: [], searchEngines: [], homepage: null, startupUrls: [], failed: ["bookmarks", "preferences", "searchEngines"] };
    assert.equal((await importer.importSettings({ browser: "chrome" })).status, "read_failed");
    assert.equal((await importer.getSettings()).searchEngines.length, 1, "nothing was overwritten when every section failed");
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("removeOptIn undoes an opt-in and is a no-op for an unknown task", async () => {
  await withImporter(async ({ config }) => {
    await config.addOptIn("t1");
    assert.equal(await config.removeOptIn("t1"), true);
    assert.equal(await config.hasOptIn("t1"), false);
    assert.equal(await config.removeOptIn("never"), false);
  });
});
