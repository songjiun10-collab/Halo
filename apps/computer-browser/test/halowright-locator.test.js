"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { validateLocator, locatorResolveSource, waitForActionable, HalowrightError } = require("../main/harness/halowright-locator");
const { CdpEngine } = require("../main/harness/cdp-engine");

const CHROMIUM = [process.env.HALO_CHROMIUM, path.join(os.homedir(), "chromium/src/out/Trial/Chromium.app/Contents/MacOS/Chromium")].find((p) => p && fs.existsSync(p));

test("validateLocator accepts the five forms and rejects the rest", () => {
  assert.deepEqual(validateLocator({ role: "button", name: "Save" }), { role: "button", name: "Save" });
  assert.deepEqual(validateLocator({ label: "Email", nth: 1 }), { label: "Email", nth: 1 });
  assert.deepEqual(validateLocator({ text: "Sign in" }), { text: "Sign in" });
  assert.deepEqual(validateLocator({ placeholder: "Search" }), { placeholder: "Search" });
  assert.deepEqual(validateLocator({ testid: "submit-btn" }), { testid: "submit-btn" });
  for (const bad of [null, "button", {}, { role: 1 }, { role: "button", css: "#a" }, { text: "x", nth: -1 }, { text: "x".repeat(300) }, { testid: "" }, { testid: "x".repeat(300) }, { testid: "a", text: "b" }, { role: "button", name: "a", label: "b" }]) {
    assert.throws(() => validateLocator(bad), (error) => error instanceof HalowrightError && error.code === "invalid_locator");
  }
});

test("waitForActionable returns resolved only after two identical positions", async () => {
  const results = [{ status: "not_found" }, { status: "resolved", x: 1, y: 2, tag: "BUTTON" }, { status: "resolved", x: 5, y: 6, tag: "BUTTON" }, { status: "resolved", x: 5, y: 6, tag: "BUTTON" }];
  const out = await waitForActionable({ resolve: async () => results.shift(), spec: { text: "x" }, sleep: async () => {}, timeoutMs: 1000, intervalMs: 100 });
  assert.equal(out.status, "resolved");
  assert.deepEqual([out.x, out.y], [5, 6]);
});

test("waitForActionable confirms a seen element after a short settle gap, not a full poll interval", async () => {
  const gaps = [];
  const results = [{ status: "not_found" }, { status: "resolved", x: 5, y: 6, tag: "A" }, { status: "resolved", x: 5, y: 6, tag: "A" }];
  const out = await waitForActionable({ resolve: async () => results.shift(), spec: { text: "x" }, sleep: async (ms) => { gaps.push(ms); }, timeoutMs: 1000, intervalMs: 100 });
  assert.equal(out.status, "resolved");
  assert.deepEqual(gaps, [100, 32]);
});

test("waitForActionable trusts a sample the page already confirmed one frame later", async () => {
  const sleeps = [];
  const out = await waitForActionable({ resolve: async () => ({ status: "resolved", x: 1, y: 2, tag: "A", stable: true }), spec: { text: "x" }, sleep: async (ms) => { sleeps.push(ms); }, timeoutMs: 1000, intervalMs: 100 });
  assert.equal(out.status, "resolved");
  assert.deepEqual(sleeps, []);
});

test("waitForActionable stops at once on an ambiguous locator and returns the last state on timeout", async () => {
  const ambiguous = await waitForActionable({ resolve: async () => ({ status: "ambiguous", count: 2, candidates: ["a", "b"] }), spec: { text: "x" }, sleep: async () => { throw new Error("must not wait"); }, timeoutMs: 1000, intervalMs: 100 });
  assert.equal(ambiguous.status, "ambiguous");
  const covered = await waitForActionable({ resolve: async () => ({ status: "not_actionable", reason: "covered" }), spec: { text: "x" }, sleep: async () => {}, timeoutMs: 300, intervalMs: 100 });
  assert.deepEqual({ status: covered.status, reason: covered.reason }, { status: "not_actionable", reason: "covered" });
});

test("hostile locator text stays inside the JSON literal", () => {
  for (const text of ['"); globalThis.__pwn=1;//', "a\u2028b\u2029c"]) {
    for (const settle of [false, true]) {
      const source = locatorResolveSource({ text }, settle);
      // The flag is a host-written boolean literal; only the JSON-encoded spec is model text.
      assert.ok(source.endsWith(`})(${JSON.stringify({ text })}, ${settle})`));
      assert.equal(source.split(JSON.stringify({ text })).length, 2, "payload appears only once, as JSON");
      assert.ok(!source.slice(0, source.length - JSON.stringify({ text }).length).includes("__pwn"));
    }
  }
  // A testid is matched by exact data-testid attribute, never as a selector.
  assert.ok(locatorResolveSource({ testid: "submit-btn" }, false).includes("[data-testid]"));
});

test("waitForActionable does not count a failed sample as a stable sighting", async () => {
  const r = { status: "resolved", x: 5, y: 6, tag: "BUTTON" };
  const seq = [r, "throw", r];
  const out = await waitForActionable({ resolve: async () => { const v = seq.shift(); if (v === "throw") throw new Error("x"); if (v === undefined) return null; return v; }, spec: { text: "x" }, sleep: async () => {}, timeoutMs: 300, intervalMs: 100 });
  assert.notEqual(out.status, "resolved");
});

const FIXTURE = `<!doctype html><title>fx</title>
<label for="em">Email</label><input id="em" placeholder="you@x.test">
<button id="save">Save</button><button id="save2">Save</button>
<button id="off" disabled>Off</button>
<button id="late" style="display:none">Later</button><script>setTimeout(() => { document.getElementById("late").style.display = "inline-block"; }, 400)</script>
<div style="position:relative"><button id="under">Under</button><div style="position:absolute;inset:0;background:#fff"></div></div>
<a href="#x">Docs link</a>
<button data-testid="checkout">Checkout</button>
<button style="display:none">Dup</button><button>Dup</button>
<div style="height:3000px"></div><button id="far">Far away</button>`;

test("the page script resolves by role, label, text and placeholder and rejects unusable targets", { skip: !CHROMIUM && "no Chromium binary", timeout: 90000 }, async (t) => {
  const server = http.createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end(FIXTURE); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const engine = new CdpEngine();
  engine.configure({ browserEngine: "chromium", chromiumPath: CHROMIUM });
  t.after(async () => { await engine.release(); await new Promise((resolve) => server.close(resolve)); });
  const page = engine.createPage("halo-task-locator");
  await page.webContents.loadURL(`http://127.0.0.1:${server.address().port}/`);
  const resolve = async (spec) => {
    const raw = await page.webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: locatorResolveSource(spec) }]);
    return JSON.parse(Array.isArray(raw) ? raw[0] : raw);
  };
  assert.equal((await resolve({ role: "link", name: "Docs link" })).status, "resolved");
  assert.equal((await resolve({ label: "Email" })).tag, "INPUT");
  assert.equal((await resolve({ placeholder: "you@x.test" })).status, "resolved");
  assert.equal((await resolve({ testid: "checkout" })).status, "resolved");
  assert.equal((await resolve({ testid: "missing" })).status, "not_found");
  assert.equal((await resolve({ role: "button", name: "Save" })).status, "ambiguous");
  assert.equal((await resolve({ role: "button", name: "Save", nth: 1 })).status, "resolved");
  assert.deepEqual(await resolve({ role: "button", name: "Off" }), { status: "not_actionable", reason: "disabled" });
  assert.deepEqual(await resolve({ role: "button", name: "Under" }), { status: "not_actionable", reason: "covered" });
  assert.equal((await resolve({ role: "button", name: "Nope" })).status, "not_found");
  assert.equal((await resolve({ role: "button", name: "Dup" })).status, "resolved");
  assert.equal((await resolve({ role: "button", name: "Far away" })).status, "resolved");
  assert.equal((await resolve({ text: '"); globalThis.__pwn=1;//' })).status, "not_found");
  assert.equal(await page.webContents.executeJavaScript("typeof globalThis.__pwn"), "undefined");
  // The late button appears after ~400 ms; auto-wait must find it without the caller sleeping.
  const waited = await waitForActionable({ resolve, spec: { role: "button", name: "Later" }, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs: 3000, intervalMs: 100 });
  assert.equal(waited.status, "resolved");
  assert.ok(waited.waitedMs >= 300);
});

test("within accepts one plain nested locator and rejects deeper nesting or unknown fields", () => {
  assert.deepEqual(validateLocator({ role: "button", name: "Save", within: { text: "Profile" } }), { role: "button", name: "Save", within: { text: "Profile" } });
  assert.deepEqual(validateLocator({ text: "Go", within: { role: "tab", nth: 1 } }), { text: "Go", within: { role: "tab", nth: 1 } });
  for (const bad of [
    { text: "a", within: { text: "b", within: { text: "c" } } },
    { text: "a", within: "css" },
    { text: "a", within: { text: "b", selector: "div" } },
    { text: "a", within: { role: "nonsense" } },
    { text: "a", within: [] },
  ]) assert.throws(() => validateLocator(bad), (e) => e.code === "invalid_locator");
});

test("within and shadow handling stay inside JSON-encoded literals", () => {
  const hostile = '"); globalThis.__pwn=1;//';
  const source = locatorResolveSource({ text: hostile, within: { label: hostile } }, true);
  assert.ok(source.endsWith(`})(${JSON.stringify({ text: hostile, within: { label: hostile } })}, true)`));
  assert.equal(source.split(JSON.stringify(hostile)).length, 3, "each payload appears once, as JSON");
});
