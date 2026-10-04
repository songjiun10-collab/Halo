"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { readChromeSettings, readSearchEngines } = require("../main/harness/profile-import/chrome-settings-reader");

async function makeProfile({ bookmarks, preferences, keywords } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "halo-chrome-settings-"));
  const dir = path.join(root, "Default");
  await fs.mkdir(dir, { recursive: true });
  if (bookmarks) await fs.writeFile(path.join(dir, "Bookmarks"), JSON.stringify(bookmarks));
  if (preferences) await fs.writeFile(path.join(dir, "Preferences"), JSON.stringify(preferences));
  if (keywords) {
    const db = new DatabaseSync(path.join(dir, "Web Data"));
    db.exec("CREATE TABLE keywords (short_name TEXT, keyword TEXT, url TEXT, safe_for_autoreplace INTEGER)");
    const insert = db.prepare("INSERT INTO keywords VALUES (?,?,?,0)");
    for (const k of keywords) insert.run(k.name, k.keyword, k.url);
    db.close();
  }
  return root;
}

const url = (name, u) => ({ type: "url", name, url: u });
const folder = (name, children) => ({ type: "folder", name, children });

test("flattens bookmarks with their folder path and keeps only http(s) URLs", async () => {
  const root = await makeProfile({ bookmarks: { roots: {
    bookmark_bar: folder("Bookmarks bar", [url("Claude", "https://claude.ai/"), folder("Work", [url("Docs", "http://docs.example.com/a"), url("JS", "javascript:alert(1)"), url("File", "file:///etc/passwd")])]),
    other: folder("Other bookmarks", [url("Mail", "https://mail.example.com/")]),
    synced: folder("Mobile bookmarks", []),
  } } });
  try {
    const result = await readChromeSettings({ chromeRoot: root });
    assert.equal(result.status, "ok");
    assert.deepEqual(result.bookmarks.map((b) => [b.folder, b.title, b.url]), [
      ["Bookmarks bar", "Claude", "https://claude.ai/"],
      ["Bookmarks bar/Work", "Docs", "http://docs.example.com/a"],
      ["Other bookmarks", "Mail", "https://mail.example.com/"],
    ]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("reads homepage and startup pages from Preferences", async () => {
  const root = await makeProfile({ preferences: { homepage: "https://start.example.com/", homepage_is_newtabpage: false, session: { restore_on_startup: 4, startup_urls: ["https://a.example.com/", "javascript:x", "https://b.example.com/"] } } });
  try {
    const result = await readChromeSettings({ chromeRoot: root });
    assert.deepEqual(result.homepage, { url: "https://start.example.com/", useNewTab: false });
    assert.deepEqual(result.startupUrls, ["https://a.example.com/", "https://b.example.com/"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("ignores startup URLs unless Chrome is set to open specific pages, and a new-tab homepage has no URL", async () => {
  const root = await makeProfile({ preferences: { homepage: "https://ignored.example.com/", homepage_is_newtabpage: true, session: { restore_on_startup: 1, startup_urls: ["https://a.example.com/"] } } });
  try {
    const result = await readChromeSettings({ chromeRoot: root });
    assert.deepEqual(result.homepage, { url: null, useNewTab: true });
    assert.deepEqual(result.startupUrls, []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("reads search engines that use https and a {searchTerms} placeholder", async () => {
  const root = await makeProfile({ keywords: [
    { name: "Google", keyword: "google.com", url: "https://www.google.com/search?q={searchTerms}" },
    { name: "Bad", keyword: "bad", url: "http://insecure.example.com/?q={searchTerms}" },
    { name: "NoTerms", keyword: "nt", url: "https://example.com/" },
    { name: "Internal", keyword: "int", url: "chrome://x/{searchTerms}" },
  ] });
  try {
    const result = await readChromeSettings({ chromeRoot: root });
    assert.deepEqual(result.searchEngines, [{ name: "Google", keyword: "google.com", url: "https://www.google.com/search?q={searchTerms}" }]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("missing files yield empty sections; a missing profile is not_found; bad profile names are rejected", async () => {
  const root = await makeProfile({ bookmarks: { roots: {} } });
  try {
    const result = await readChromeSettings({ chromeRoot: root });
    assert.deepEqual([result.status, result.bookmarks, result.searchEngines, result.startupUrls, result.homepage], ["ok", [], [], [], null]);
    assert.equal((await readChromeSettings({ chromeRoot: root, profile: "Profile 9" })).status, "not_found");
    await assert.rejects(readChromeSettings({ chromeRoot: root, profile: "../x" }), { code: "invalid_config" });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("caps oversized bookmark sets and tolerates corrupt JSON", async () => {
  const many = Array.from({ length: 6000 }, (_, i) => url(`b${i}`, `https://example.com/${i}`));
  const root = await makeProfile({ bookmarks: { roots: { bookmark_bar: folder("Bookmarks bar", many) } } });
  try {
    assert.equal((await readChromeSettings({ chromeRoot: root })).bookmarks.length, 5000);
    await fs.writeFile(path.join(root, "Default", "Preferences"), "{not json");
    const result = await readChromeSettings({ chromeRoot: root });
    assert.equal(result.status, "ok");
    assert.equal(result.homepage, null);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("an unreadable or malformed file is reported as failed, while a missing file is simply empty", async () => {
  const root = await makeProfile({ preferences: { homepage: "https://home.example/" } });
  try {
    // Missing Bookmarks and Web Data are legitimately empty, not failures.
    const missing = await readChromeSettings({ chromeRoot: root });
    assert.equal(missing.failed, undefined);
    assert.equal(missing.homepage.url, "https://home.example/");

    await fs.writeFile(path.join(root, "Default", "Bookmarks"), "{ not json");
    await fs.rm(path.join(root, "Default", "Preferences"));
    await fs.mkdir(path.join(root, "Default", "Preferences"));
    const broken = await readChromeSettings({ chromeRoot: root });
    assert.equal(broken.status, "ok");
    assert.deepEqual(broken.failed.sort(), ["bookmarks", "preferences"]);
    assert.deepEqual(broken.bookmarks, []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("an unreadable Web Data database is reported as a failed searchEngines section", async () => {
  const root = await makeProfile({});
  try {
    await fs.writeFile(path.join(root, "Default", "Web Data"), "this is not a sqlite database");
    const result = await readChromeSettings({ chromeRoot: root });
    assert.deepEqual(result.failed, ["searchEngines"]);
    assert.deepEqual(result.searchEngines, []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a missing Web Data file is empty but an access error preserves the prior section", async () => {
  assert.deepEqual(await readSearchEngines("missing", { access: async () => { throw Object.assign(new Error(), { code: "ENOENT" }); } }), []);
  assert.equal(await readSearchEngines("protected", { access: async () => { throw Object.assign(new Error(), { code: "EACCES" }); } }), null);
});
