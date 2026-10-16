"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { BrowserAdapter } = require("../main/harness/browser-adapter");

const TASK = "11111111-1111-4111-8111-111111111111";
const lane = (extra = {}) => ({ x: 0.3, y: 0.8, key: "d", color: [255, 40, 40], tolerance: 60, ...extra });

// A fake page. `hits(call)` decides what the in-page sampler answers on its nth call.
function fixture({ hits = () => [false], url = "https://game.test/play", options = {} } = {}) {
  const wc = new EventEmitter();
  const keys = [];
  let calls = 0;
  let current = url;
  Object.assign(wc, {
    getURL: () => current,
    close() {},
    sendInputEvent: (event) => keys.push(event),
    insertText() {},
    executeJavaScriptInIsolatedWorld: async (_world, scripts) => {
      const code = scripts[0].code;
      if (code.includes("__haloPlaySample")) { calls += 1; return hits(calls); }
      return { url: current, title: "game", text: "", elements: [] };
    },
  });
  const view = { webContents: wc, getBounds: () => ({ x: 0, y: 0, width: 1000, height: 700 }) };
  const adapter = new BrowserAdapter({ view, permissionMode: "interact", ...options });
  const arm = async () => {
    const observation = await adapter.observe();
    adapter.authorizeVisualBinding({ observationId: observation.id, taskId: TASK, agentId: null, documentEpoch: observation.documentEpoch, origin: new URL(current).origin, capturedAt: 1, viewport: { width: 1000, height: 700 }, digest: "0".repeat(64) });
    return observation;
  };
  return { adapter, wc, keys, arm, navigate: (next) => { current = next; }, calls: () => calls };
}
const loop = (observation, extra = {}) => ({ type: "play_loop", observationId: observation.id, seconds: 0.4, lanes: [lane()], ...extra });

test("play_loop presses the lane's key when its note arrives, and the next look reports what happened", async () => {
  const f = fixture({ hits: (n) => [n === 5 || n === 40] });
  const observation = await f.arm();
  const result = await f.adapter.execute(loop(observation), { documentEpoch: observation.documentEpoch });
  assert.equal(result.status, "ok");
  const downs = f.keys.filter((e) => e.type === "keyDown");
  assert.deepEqual(downs.map((e) => e.keyCode), ["d", "d"]);
  assert.deepEqual(f.keys.filter((e) => e.type === "keyUp").map((e) => e.keyCode), ["d", "d"]);
  const next = await f.adapter.observe();
  assert.equal(next.playLoop.stopped, "time");
  assert.deepEqual(next.playLoop.presses, [{ key: "d", count: 2 }]);
  assert.equal(next.playLoop.total, 2);
  assert.equal((await f.adapter.observe()).playLoop, undefined, "the report is shown once");
});

test("the approval covers one run: the same observation cannot start a second loop", async () => {
  const f = fixture();
  const observation = await f.arm();
  assert.equal((await f.adapter.execute(loop(observation, { seconds: 0.05 }), { documentEpoch: observation.documentEpoch })).status, "ok");
  assert.deepEqual(await f.adapter.execute(loop(observation, { seconds: 0.05 }), { documentEpoch: observation.documentEpoch }), { status: "failed", errorCode: "stale_visual_observation" });
});

test("an unreadable canvas (WebGL, cross-origin, none) fails with its own code and presses nothing", async () => {
  const f = fixture({ hits: () => null });
  const observation = await f.arm();
  assert.deepEqual(await f.adapter.execute(loop(observation), { documentEpoch: observation.documentEpoch }), { status: "failed", errorCode: "canvas_unreadable" });
  assert.deepEqual(f.keys, []);
});

test("the stop button (an aborted signal) ends the loop and cancels", async () => {
  const f = fixture();
  const observation = await f.arm();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 60);
  const started = Date.now();
  const result = await f.adapter.execute(loop(observation, { seconds: 30 }), { documentEpoch: observation.documentEpoch, signal: controller.signal });
  assert.deepEqual(result, { status: "cancelled", errorCode: "aborted" });
  assert.ok(Date.now() - started < 2000);
});

test("the loop stops the moment the page navigates, so keys never go to another site", async () => {
  const f = fixture({ hits: (n) => { if (n === 3) f.navigate("https://other.test/"); return [true]; } });
  const observation = await f.arm();
  const result = await f.adapter.execute(loop(observation, { seconds: 5 }), { documentEpoch: observation.documentEpoch });
  assert.equal(result.status, "ok");
  const next = await f.adapter.observe();
  assert.equal(next.playLoop.stopped, "navigated");
  const before = f.keys.length;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(f.keys.length, before, "nothing is pressed after it stopped");
});

test("keys outside the allowed set never reach the page, even from a hand-built action", async () => {
  const f = fixture({ hits: () => [true] });
  const observation = await f.arm();
  for (const key of ["Enter", " ", "Tab"]) {
    const result = await f.adapter.execute(loop(observation, { lanes: [lane({ key })] }), { documentEpoch: observation.documentEpoch });
    assert.equal(result.status, "failed");
  }
  assert.deepEqual(f.keys, []);
});

test("play_loop needs interact mode or more: observe and browse refuse it", async () => {
  for (const mode of ["observe", "browse"]) {
    const f = fixture({ options: { permissionMode: mode } });
    const observation = await f.arm();
    assert.deepEqual(await f.adapter.execute(loop(observation), { documentEpoch: observation.documentEpoch }), { status: "failed", errorCode: "permission_mode_denied" });
  }
});
