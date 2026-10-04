"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { makeEntry, addEntry, prune, recall, pageKey } = require("../main/harness/activity-journal");
const { ActivityJournalStore } = require("../main/harness/activity-journal-store");

const AT = "2026-10-04T10:00:00.000Z";
const visit = (url, title, excerpt = "", extra = {}) => makeEntry({ url, title, excerpt, at: AT, ...extra }, `id-${Math.random()}`);

test("only plain https pages are recorded, with query and fragment stripped", () => {
  assert.deepEqual(pageKey("https://news.example.com/a/b?token=1#x"), { url: "https://news.example.com/a/b", origin: "https://news.example.com" });
  for (const url of ["http://example.com/", "https://user:pw@example.com/", "https://localhost/", "https://192.168.0.2/", "https://printer.local/", "file:///etc/passwd", "nonsense", 7]) assert.equal(pageKey(url), null, String(url));
});

test("sign-in, payment, mail, bank and account pages and sensitive fields are never recorded", () => {
  for (const url of ["https://accounts.google.com/x", "https://mail.google.com/", "https://www.mybank.com/home", "https://shop.example.com/checkout", "https://example.com/login", "https://paypal.com/", "https://example.com/account/settings"]) {
    assert.equal(visit(url, "Title"), null, url);
  }
  assert.equal(visit("https://example.com/a", "Title", "text", { hasSensitiveField: true }), null);
  assert.equal(visit("https://example.com/a", "", ""), null);
  assert.ok(visit("https://example.com/post", "Investing basics"));
});

test("text is bounded and a quick revisit refreshes instead of duplicating", () => {
  const long = visit("https://example.com/p", "T".repeat(500), "x".repeat(5000));
  assert.ok(long.title.length <= 200 && long.excerpt.length <= 600);
  const first = visit("https://example.com/p", "One");
  const again = { ...visit("https://example.com/p", "Two"), visitedAt: "2026-10-04T10:10:00.000Z" };
  const list = addEntry([first], again);
  assert.equal(list.length, 1);
  assert.equal(list[0].title, "Two");
  const later = { ...visit("https://example.com/p", "Three"), visitedAt: "2026-10-04T12:00:00.000Z" };
  assert.equal(addEntry(list, later).length, 2);
});

test("entries older than the retention window are pruned", () => {
  const old = { ...visit("https://example.com/old", "Old"), visitedAt: "2026-09-01T00:00:00.000Z" };
  assert.deepEqual(prune([old, visit("https://example.com/new", "New")], AT).map((e) => e.title), ["New"]);
});

test("recall returns only pages sharing a word with the request, best first, and nothing for an empty request", () => {
  const entries = [
    visit("https://a.example.com/1", "Index fund investing guide", "how to invest in index funds"),
    visit("https://b.example.com/2", "Hotel list Busan", "ocean view hotels, pros and cons"),
    visit("https://c.example.com/3", "Pasta recipe", "boil water"),
  ];
  const hits = recall(entries, "summarize the hotel pros and cons I looked at");
  assert.equal(hits.length, 1);
  assert.match(hits[0].text, /Hotel list Busan/);
  assert.match(hits[0].text, /^Visited 2026-10-04:/);
  assert.deepEqual(recall(entries, "   "), []);
  assert.deepEqual(recall(entries, "quantum chromodynamics"), []);
  assert.equal(recall(entries, "투자").length, 0);
  assert.equal(recall([visit("https://k.example.com/", "투자 기초 정리")], "어제 읽었던 투자 글 찾아줘").length, 1);
});

test("the store keeps entries encrypted, recalls them, and clear removes everything", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "halo-journal-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (s) => Buffer.from(Buffer.from(s).toString("base64")),
    decryptString: (b) => Buffer.from(b.toString(), "base64").toString(),
  };
  const store = new ActivityJournalStore({ storageRoot: root, safeStorage, now: () => AT });
  assert.equal(await store.record({ url: "https://example.com/p?q=1", title: "Index funds", excerpt: "invest" }), true);
  assert.equal(await store.record({ url: "https://example.com/login", title: "Sign in" }), false);
  const raw = await fs.readFile(path.join(root, "activity-journal.enc"), "utf8");
  assert.ok(!raw.includes("Index funds"));
  assert.equal((await store.recall("funds"))[0].origin, "https://example.com");
  assert.equal((await store.list()).length, 1);
  await store.clear();
  assert.deepEqual(await store.list(), []);
  const bare = new ActivityJournalStore({ storageRoot: root, safeStorage: null });
  await assert.rejects(() => bare.list(), { code: "encryption_unavailable" });
});

const { createPageVisitSink } = require("../main/activity-capture");
const { validateSettings, DEFAULT_SETTINGS } = require("../main/harness/host-settings");

function fakeContents(url, page) {
  return { getURL: () => url, getTitle: () => "A page", executeJavaScript: async () => page };
}

test("the capture sink does nothing while Context Awareness is off", async () => {
  const recorded = [];
  const sink = createPageVisitSink({ isEnabled: async () => false, record: async (v) => { recorded.push(v); } });
  await sink(fakeContents("https://example.com/a", { excerpt: "text" }));
  assert.equal(recorded.length, 0);
});

test("the capture sink records once per burst, passes the sensitive-field flag, and never throws", async () => {
  const recorded = []; let clock = 0;
  const sink = createPageVisitSink({ isEnabled: async () => true, record: async (v) => { recorded.push(v); }, now: () => clock });
  const wc = fakeContents("https://example.com/a", { excerpt: "text", hasSensitiveField: false });
  await sink(wc); await sink(wc);
  assert.equal(recorded.length, 1);
  clock = 60_000;
  await sink(fakeContents("https://example.com/a", { hasSensitiveField: true }));
  assert.equal(recorded[1].hasSensitiveField, true);
  await sink({ getURL: () => { throw new Error("gone"); } });
  await createPageVisitSink({ isEnabled: async () => true, record: async () => { throw new Error("disk"); } })(wc);
});

test("contextAwareness is an optional boolean host setting, off unless set", () => {
  const base = { ...DEFAULT_SETTINGS };
  assert.equal("contextAwareness" in validateSettings(base), false);
  assert.equal(validateSettings({ ...base, contextAwareness: true }).contextAwareness, true);
  assert.throws(() => validateSettings({ ...base, contextAwareness: "on" }), { code: "invalid_context_awareness" });
});
