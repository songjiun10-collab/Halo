"use strict";

// The regression a real Chromium freeze exposed: a cached isolated-world
// executionContextId outlives the context it names.
//
// Page.setWebLifecycleState("frozen") (which ParkableView.freeze() sends,
// together with Memory.forciblyPurgeJavaScriptMemory) destroys each execution
// context with its OWN Runtime.executionContextDestroyed event and never emits
// Runtime.executionContextsCleared. A world cached before the freeze therefore
// survived as a dead id, and the next isolated-world call failed with
// "Cannot find context with specified id" -- the failure behind
// renderer-lifecycle.test.js's real-Chromium case.
//
// Clearing the cache is not sufficient on its own: Chromium keys created
// isolated worlds by name for the life of the frame, so re-creating the SAME
// worldName returns the dead contextId forever. A per-incarnation name suffix
// is what produces a live world again.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const { CdpWebContents } = require("../main/harness/cdp-web-contents");

const CHROMIUM = [process.env.HALO_CHROMIUM, path.join(os.homedir(), "chromium/src/out/Trial/Chromium.app/Contents/MacOS/Chromium")]
  .find((p) => p && fs.existsSync(p));
const skip = !CHROMIUM && "no Chromium binary";

// A transport that answers only the commands init() and the isolated-world path
// need, so the invalidation rules can be tested without a browser.
function fakeTransport({ worldId = 3 } = {}) {
  const sent = [];
  const handlers = new Set();
  const dead = new Set();
  return {
    sent,
    worldsByName: new Map(),
    liveContextId: worldId,
    dead,
    nextWorldId: worldId,
    killContexts(...ids) { for (const id of ids) dead.add(id); },
    revive() { this.nextWorldId += 1; this.liveContextId = this.nextWorldId; return this.liveContextId; },
    send(method, params = {}, sessionId) {
      sent.push({ method, params, sessionId });
      if (dead.has(params.contextId)) return Promise.reject(new Error("cdp_error: Cannot find context with specified id"));
      if (method === "Page.createIsolatedWorld") {
        // Real Chromium returns the SAME dead id for a worldName it already
        // knows, no matter how many times it is asked.
        const known = this.worldsByName.get(params.worldName);
        if (known !== undefined) return Promise.resolve({ executionContextId: known });
        this.nextWorldId += 1;
        this.worldsByName.set(params.worldName, this.nextWorldId);
        return Promise.resolve({ executionContextId: this.nextWorldId });
      }
      if (method === "Runtime.evaluate") return Promise.resolve({ result: { value: "ok" } });
      if (method === "Target.setDiscoverTargets" || method === "Target.createTarget" || method === "Target.attachToTarget") {
        return Promise.resolve({ targetId: "t1", sessionId: "s1", browserContextId: "c1" });
      }
      if (method === "Page.getFrameTree") return Promise.resolve({ frameTree: { frame: { id: "f1", url: "about:blank" } } });
      if (method === "Page.getNavigationHistory") return Promise.resolve({ entries: [], currentIndex: -1 });
      return Promise.resolve({});
    },
    onEvent(handler) { handlers.add(handler); return () => handlers.delete(handler); },
    emit(method, params = {}, sessionId = "s1") { for (const h of [...handlers]) h(method, params, sessionId); },
    close() {},
  };
}

async function makePage(transport) {
  const page = new CdpWebContents(async () => transport, { url: "about:blank" });
  await page.ready;
  return page;
}

test("a cached isolated world is rebuilt after its context is destroyed", { skip }, async (t) => {
  const transport = fakeTransport();
  const page = await makePage(transport);
  t.after(() => page.close());

  assert.equal(await page.executeJavaScriptInIsolatedWorld(7, [{ code: "1" }]), "ok");
  assert.deepEqual([...page.worlds.values()], [4], "the world id is cached after first use");
  const firstWorldName = transport.sent.find((c) => c.method === "Page.createIsolatedWorld").params.worldName;

  // What a lifecycle freeze does: destroy this page's contexts, individually.
  transport.killContexts(2, 4);
  transport.emit("Runtime.executionContextDestroyed", { executionContextId: 4 });
  assert.deepEqual([...page.worlds.values()], [], "the destroy event drops the dead world");

  assert.equal(await page.executeJavaScriptInIsolatedWorld(7, [{ code: "2" }]), "ok");
  const replacement = [...page.worlds.values()][0];
  assert.notEqual(replacement, 4, "a live world replaces the destroyed one");
  const names = transport.sent.filter((c) => c.method === "Page.createIsolatedWorld").map((c) => c.params.worldName);
  assert.notEqual(names.at(-1), firstWorldName, "the rebuilt world must not reuse the dead name");
});

test("a main-frame navigation invalidates cached worlds with a fresh name", { skip }, async (t) => {
  const transport = fakeTransport();
  const page = await makePage(transport);
  t.after(() => page.close());

  await page.executeJavaScriptInIsolatedWorld(7, [{ code: "1" }]);
  transport.emit("Page.frameNavigated", { frame: { id: "f1", url: "https://example.test/" } });
  assert.deepEqual([...page.worlds.values()], [], "navigation drops the world");

  await page.executeJavaScriptInIsolatedWorld(7, [{ code: "2" }]);
  const names = transport.sent.filter((c) => c.method === "Page.createIsolatedWorld").map((c) => c.params.worldName);
  assert.equal(new Set(names).size, names.length, `each incarnation gets a distinct world name: ${names.join(",")}`);
});

test("a context that dies before its event still recovers exactly once", { skip }, async (t) => {
  const transport = fakeTransport();
  const page = await makePage(transport);
  t.after(() => page.close());

  await page.executeJavaScriptInIsolatedWorld(7, [{ code: "1" }]);
  // No event this time: the id is simply dead by the next call.
  transport.killContexts(...page.worlds.values());
  transport.revive();

  assert.equal(await page.executeJavaScriptInIsolatedWorld(7, [{ code: "2" }]), "ok", "the call recovers instead of throwing");
  const creates = transport.sent.filter((c) => c.method === "Page.createIsolatedWorld").length;
  assert.equal(creates, 2, "recovery creates exactly one replacement world");
});

test("a page script that throws the same text is not mistaken for a dead world", { skip }, async (t) => {
  const transport = fakeTransport();
  const original = transport.send.bind(transport);
  transport.send = (method, params, sessionId) => {
    if (method === "Runtime.evaluate" && params.expression === "boom") {
      return Promise.resolve({ exceptionDetails: { text: "Error: Cannot find context with specified id" } });
    }
    return original(method, params, sessionId);
  };
  const page = await makePage(transport);
  t.after(() => page.close());

  await page.executeJavaScriptInIsolatedWorld(7, [{ code: "1" }]);
  await assert.rejects(
    page.executeJavaScriptInIsolatedWorld(7, [{ code: "boom" }]),
    /script_error/,
    "a script_error surfaces as itself",
  );
  const creates = transport.sent.filter((c) => c.method === "Page.createIsolatedWorld").length;
  assert.equal(creates, 1, "no extra world is created for a page-level script error");
});

test("real Chromium: an isolated world survives freeze and thaw", { skip }, async (t) => {
  const server = http.createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end("<title>t</title><h1>hi</h1>"); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const { acquireCdpBrowser } = require("../main/harness/cdp-browser-host");
  const { connectCdpTransport } = require("../main/harness/cdp-web-contents");
  const browser = await acquireCdpBrowser({ executablePath: CHROMIUM, headless: true });
  const transport = await connectCdpTransport(browser.wsUrl);
  t.after(async () => { transport.close(); await browser.close(); await new Promise((r) => server.close(r)); });

  const page = new CdpWebContents(async () => transport, { url: `${base}/a` });
  await page.ready;
  t.after(() => page.close());

  assert.equal(await page.executeJavaScriptInIsolatedWorld(7, [{ code: "document.title" }]), "t");

  // Exactly what ParkableView.freeze() sends. The purge is the load-bearing
  // half: setWebLifecycleState("frozen") on its own leaves the world alive.
  await page.rawCmd("Page.setWebLifecycleState", { state: "frozen" });
  await page.rawCmd("Memory.forciblyPurgeJavaScriptMemory");
  await page.rawCmd("Page.setWebLifecycleState", { state: "active" });

  assert.equal(await page.executeJavaScriptInIsolatedWorld(7, [{ code: "document.title" }]), "t",
    "the world works again after a freeze/thaw cycle");
  // The replacement contextId is not asserted to differ: Chromium is free to
  // hand back the same integer for a freshly created world. What matters is
  // that evaluate resolves, which it cannot do against the destroyed context.
  assert.ok(page.worlds.has(7), "a live world is cached again");
});