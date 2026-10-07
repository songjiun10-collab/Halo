"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const { ParkableView, SurfacePool, wakeOnUse } = require("../main/harness/renderer-lifecycle");
const { CdpEngine } = require("../main/harness/cdp-engine");
const { BrowserAdapter } = require("../main/harness/browser-adapter");

const CHROMIUM = [process.env.HALO_CHROMIUM, path.join(os.homedir(), "chromium/src/out/Trial/Chromium.app/Contents/MacOS/Chromium")].find((p) => p && fs.existsSync(p));

function fakeInner(log) {
  const wc = new EventEmitter();
  wc.url = "about:blank";
  wc.getURL = () => wc.url;
  wc.getTitle = () => "title";
  wc.session = { name: "s" };
  wc.rawCmd = async (method, params) => { log.push(["cmd", method, params?.state]); };
  wc.loadURL = async (url) => { wc.url = url; wc.emit("did-navigate", {}, url, 200); log.push(["load", url]); };
  wc.executeJavaScript = async () => "ran";
  wc.sendInputEvent = () => log.push(["input"]);
  wc.close = () => log.push(["close"]);
  return { view: { webContents: wc, setBounds() {}, setVisible() {} }, dispose: () => log.push(["dispose"]) };
}

function clock() { const c = { t: 0 }; c.now = () => c.t; return c; }

test("wake waits for initial Chromium readiness before starting adapter deadlines", async () => {
  const inner = fakeInner([]);
  let ready;
  inner.view.webContents.ready = new Promise((resolve) => { ready = resolve; });
  const view = new ParkableView({ create: () => inner });
  let started = false;
  const adapter = wakeOnUse({ execute: async () => { started = true; return "ok"; } }, view);
  const call = adapter.execute();
  await new Promise((resolve) => setImmediate(resolve));
  const premature = started;
  ready();
  assert.equal(await call, "ok");
  assert.equal(premature, false);
  view.webContents.close();
});

test("parkable surfaces expose direct JPEG only when supported and pin captures", async () => {
  const plain = new ParkableView({ create: () => fakeInner([]) });
  assert.equal(plain.webContents.captureJpeg, undefined);
  let finish;
  const inner = fakeInner([]);
  inner.view.webContents.captureJpeg = () => new Promise((resolve) => { finish = resolve; });
  const view = new ParkableView({ create: () => inner });
  const capture = view.webContents.captureJpeg({ maxWidth: 1200, quality: 65 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await view.discard(), false);
  finish(Buffer.from("jpeg"));
  assert.equal((await capture).toString(), "jpeg");
  view.webContents.close();
  plain.webContents.close();
});

test("a discarded surface restores with one GET and tells the adapter the document changed", async () => {
  const log = [];
  const view = new ParkableView({ create: () => fakeInner(log) });
  await view.webContents.loadURL("http://127.0.0.1/page");
  let navigations = 0;
  view.webContents.on("did-navigate", () => { navigations += 1; });
  assert.equal(await view.discard(), true);
  assert.equal(view.state, "discarded");
  assert.equal(view.webContents.getURL(), "http://127.0.0.1/page", "the url is kept while parked");
  assert.equal(view.webContents.session.name, "s", "the session survives a discard");
  assert.throws(() => view.webContents.sendInputEvent({}), /surface_parked/, "input never wakes a parked surface");
  assert.equal(await view.webContents.executeJavaScript("1"), "ran");
  assert.equal(view.state, "active");
  assert.equal(navigations, 1, "restoring fires did-navigate so every earlier observation is stale");
  assert.deepEqual(log.filter((e) => e[0] === "load").map((e) => e[1]), ["http://127.0.0.1/page", "http://127.0.0.1/page"]);
});

test("freeze and thaw are lifecycle commands, and a failing freeze never blocks the surface", async () => {
  const log = [];
  const view = new ParkableView({ create: () => fakeInner(log) });
  assert.equal(await view.freeze(), true);
  assert.equal(view.state, "frozen");
  assert.throws(() => view.webContents.sendInputEvent({}), /surface_frozen/);
  await view.webContents.executeJavaScript("1");
  assert.equal(view.state, "active");
  assert.deepEqual(log.filter((e) => e[0] === "cmd" && e[1] === "Page.setWebLifecycleState").map((e) => e[2]), ["frozen", "active"]);

  const broken = new ParkableView({ create: () => { const i = fakeInner([]); i.view.webContents.rawCmd = async () => { throw new Error("no"); }; return i; } });
  assert.equal(await broken.freeze(), false);
  assert.equal(broken.state, "active");
});

test("a surface mid-call is never frozen or discarded", async () => {
  const log = [];
  let release;
  const inner = fakeInner(log);
  inner.view.webContents.executeJavaScript = () => new Promise((resolve) => { release = () => resolve("done"); });
  const view = new ParkableView({ create: () => inner });
  const call = view.webContents.executeJavaScript("slow");
  await new Promise((r) => setImmediate(r));
  assert.equal(await view.discard(), false);
  assert.equal(await view.freeze(), false);
  release();
  assert.equal(await call, "done");
});

test("pool: over-cap surfaces are discarded least-recently-used first, pinned ones never", async () => {
  const c = clock();
  const pool = new SurfacePool({ maxActive: 2, freezeAfterMs: 10_000, discardAfterMs: 100_000, minIdleMs: 1000 });
  const views = [];
  for (let i = 0; i < 4; i += 1) {
    const view = new ParkableView({ create: () => fakeInner([]), now: c.now });
    views.push(view);
    pool.register(`s${i}`, view);
    c.t += 2000; // s0 is the oldest
    view.lastUsedAt = c.t;
  }
  c.t += 2000;
  pool.pin("s0");
  await pool.sweep();
  assert.deepEqual(views.map((v) => v.state), ["active", "discarded", "discarded", "active"]);
  assert.deepEqual(pool.counts(), { active: 2, frozen: 0, discarded: 2 });
});

test("pool: idle surfaces freeze, then discard, and memory pressure acts on demand", async () => {
  const c = clock();
  const pool = new SurfacePool({ maxActive: 10, freezeAfterMs: 10_000, discardAfterMs: 100_000 });
  const logA = [];
  const view = new ParkableView({ create: () => fakeInner(logA), now: c.now });
  pool.register("a", view);
  c.t = 11_000; await pool.sweep();
  assert.equal(view.state, "frozen");
  assert.ok(logA.some(([kind, method]) => kind === "cmd" && method === "Memory.forciblyPurgeJavaScriptMemory"));
  c.t = 101_000; await pool.sweep(); assert.equal(view.state, "discarded");
  const logB = [];
  const other = new ParkableView({ create: () => fakeInner(logB), now: c.now });
  pool.register("b", other);
  c.t += 5_000;
  assert.equal(await pool.relieve("soft"), 1);
  assert.equal(other.state, "frozen");
  assert.ok(logB.some(([kind, method]) => kind === "cmd" && method === "Memory.forciblyPurgeJavaScriptMemory"));
  assert.equal(await pool.relieve("hard"), 1);
  assert.equal(other.state, "discarded");
});

test("closing a parked surface emits destroyed once and leaves no renderer", async () => {
  const log = [];
  const view = new ParkableView({ create: () => fakeInner(log) });
  await view.discard();
  let destroyed = 0;
  view.webContents.on("destroyed", () => { destroyed += 1; });
  view.webContents.close(); view.webContents.close();
  assert.equal(destroyed, 1);
  assert.equal(view.webContents.isDestroyed(), true);
  await assert.rejects(view.webContents.executeJavaScript("1"), /surface_closed/);
});

test("real Chromium: BrowserAdapter survives freeze and discard; old observations go stale; cookies stay", { skip: !CHROMIUM && "no Chromium binary", timeout: 90000 }, async (t) => {
  const server = http.createServer((request, response) => { response.setHeader("content-type", "text/html"); response.end(`<title>t</title><h1>page ${request.url}</h1><a href="/next">go</a>`); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const engine = new CdpEngine();
  engine.configure({ browserEngine: "chromium", chromiumPath: CHROMIUM });
  t.after(async () => { await engine.release(); await new Promise((resolve) => server.close(resolve)); });
  const view = new ParkableView({ create: () => ({ view: engine.createPage("halo-task-lifecycle"), dispose() {} }) });
  const adapter = wakeOnUse(new BrowserAdapter({ view }), view);

  assert.equal((await adapter.execute({ type: "navigate", url: `${base}/a` })).status, "ok");
  const before = await adapter.observe();
  await view.webContents.executeJavaScript("document.cookie = 'k=1; path=/'");

  assert.equal(await view.freeze(), true);
  const afterFreeze = await adapter.observe();
  assert.equal(view.state, "active", "observing thaws the surface");
  assert.match(afterFreeze.url, /\/a$/);

  assert.equal(await view.discard(), true);
  const afterDiscard = await adapter.observe();
  assert.match(afterDiscard.url, /\/a$/, "the saved url is restored");
  assert.ok(afterDiscard.documentEpoch > before.documentEpoch, "a restore is a new document");
  assert.equal(await view.webContents.executeJavaScript("document.cookie"), "k=1", "the partition keeps the session");
  const stale = await adapter.execute({ type: "follow_link", elementId: before.elements.find((e) => e.role === "link")?.id, observationId: before.id, documentEpoch: before.documentEpoch });
  assert.notEqual(stale.status, "ok", "an action from before the park is rejected");
  await adapter.dispose();
});

test("pool: onIdle fires once after every surface is parked for idleShutdownMs, and re-arms on use", async () => {
  const c = clock();
  let fired = 0;
  const pool = new SurfacePool({ maxActive: 10, freezeAfterMs: 1_000, discardAfterMs: 2_000, idleShutdownMs: 5_000 }, { onIdle: () => { fired += 1; }, now: c.now });
  const view = new ParkableView({ create: () => fakeInner([]), now: c.now });
  pool.register("a", view);
  c.t = 1_500; await pool.sweep(); assert.equal(view.state, "frozen");
  c.t = 3_000; await pool.sweep(); assert.equal(view.state, "discarded");
  c.t = 7_000; await pool.sweep(); assert.equal(fired, 0, "idle clock started at 3s when nothing held a renderer");
  c.t = 8_500; await pool.sweep(); assert.equal(fired, 1);
  c.t = 30_000; await pool.sweep(); assert.equal(fired, 1, "once per idle stretch");
  await view.wake();
  c.t = 31_000; await pool.sweep(); assert.equal(fired, 1, "a live surface holds the browser");
  pool.pin("a");
  c.t = 200_000; await pool.sweep(); assert.equal(view.state !== "discarded", true, "pinned surface stays");
  assert.equal(fired, 1);
});

test("real Chromium: after the whole browser is released on idle, the next use cold-starts a new one at the saved url", { skip: !CHROMIUM && "no Chromium binary", timeout: 90000 }, async (t) => {
  const server = http.createServer((request, response) => { response.setHeader("content-type", "text/html"); response.end(`<title>t</title><h1>page ${request.url}</h1>`); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const engine = new CdpEngine();
  engine.configure({ browserEngine: "chromium", chromiumPath: CHROMIUM });
  t.after(async () => { await engine.release(); await new Promise((resolve) => server.close(resolve)); });
  const view = new ParkableView({ create: () => ({ view: engine.createPage("halo-task-idle"), dispose() {} }) });
  const adapter = wakeOnUse(new BrowserAdapter({ view }), view);
  const pool = new SurfacePool({ freezeAfterMs: 0, discardAfterMs: 0, minIdleMs: 0, idleShutdownMs: 1 }, { onIdle: () => engine.release() });
  pool.register("a", view);

  assert.equal((await adapter.execute({ type: "navigate", url: `${base}/a` })).status, "ok");
  const { transport: oldTransport } = await engine.connect();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await pool.sweep();
  assert.equal(view.state, "discarded");
  await new Promise((resolve) => setTimeout(resolve, 20));
  await pool.sweep();
  await assert.rejects(oldTransport.send("Browser.getVersion"), /cdp_closed/, "idle released the old browser connection");

  const after = await adapter.observe();
  assert.match(after.url, /\/a$/, "restored on a freshly launched browser");
  const { transport: newTransport } = await engine.connect();
  assert.notEqual(newTransport, oldTransport, "restoration uses a new live connection");
  assert.ok((await newTransport.send("Browser.getVersion")).product);
  await adapter.dispose();
});
