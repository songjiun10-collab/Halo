"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createSurfaceStreams } = require("../main/surface-stream");

function fakeWindow(page) {
  const sent = [];
  const win = {
    isDestroyed: () => false,
    contentView: { children: [{ webContents: page, getBounds: () => ({ width: 800, height: 600 }), getVisible: () => true }] },
    webContents: { send: (channel, payload) => sent.push([channel, payload]) },
    once: () => {},
  };
  return { win, sent };
}
function fakePage() {
  const page = { isDestroyed: () => false, started: 0, stopped: 0, emit: null,
    async startScreencast(options, onFrame) { page.started += 1; page.options = options; page.emit = onFrame; },
    async stopScreencast() { page.stopped += 1; } };
  return page;
}

test("a stream pushes only the newest frame on the surface channel", async () => {
  const page = fakePage();
  const { win, sent } = fakeWindow(page);
  const streams = createSurfaceStreams();
  assert.equal(await streams.start(win), true);
  assert.equal(page.options.maxWidth, 1600);
  page.emit("AAA"); page.emit("BBB"); page.emit("CCC");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(sent, [["halo:surfaceFrame", { frame: "data:image/jpeg;base64,CCC" }]]);
  assert.equal(await streams.stop(win), true);
  assert.equal(page.stopped, 1);
  page.emit("DDD");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(sent.length, 1, "nothing is sent after stop");
  assert.equal(await streams.stop(win), false);
});

test("restarting replaces the old stream, and engines that cannot stream answer false", async () => {
  const page = fakePage();
  const { win } = fakeWindow(page);
  const streams = createSurfaceStreams();
  await streams.start(win);
  await streams.start(win);
  assert.equal(page.started, 2);
  assert.equal(page.stopped, 1, "the previous stream was stopped first");
  const plain = fakeWindow({ isDestroyed: () => false });
  assert.equal(await streams.start(plain.win), false);
  const failing = fakePage(); failing.startScreencast = async () => { throw new Error("nope"); };
  assert.equal(await streams.start(fakeWindow(failing).win), false);
});

test("an agent stream is task-scoped, newest-frame-only, and falls back when the host cannot stream", async () => {
  const sent = [];
  const win = { isDestroyed: () => false, webContents: { send: (c, p) => sent.push([c, p]) }, once: () => {} };
  const streams = createSurfaceStreams();
  let emit; let stops = 0;
  const open = async (taskId, onFrame) => { emit = onFrame; return async () => { stops += 1; }; };
  assert.equal(await streams.startAgent(win, "t1", open), true);
  emit("AAA"); emit("BBB");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(sent, [["halo:agentFrame", { taskId: "t1", frame: "data:image/jpeg;base64,BBB" }]]);
  assert.equal(await streams.stopAgent(win), true);
  assert.equal(stops, 1);
  emit("CCC");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(sent.length, 1);
  assert.equal(await streams.startAgent(win, "t1", async () => null), false);
  assert.equal(await streams.startAgent(win, "", open), false);
  assert.equal(await streams.stopAgent(win), false);
});

test("a page that can capture stills streams full-density stills, with the screencast only as a paint signal", async () => {
  const page = fakePage();
  let captures = 0;
  page.captureJpeg = async () => { captures += 1; return Buffer.from(`HI${captures}`); };
  const { win, sent } = fakeWindow(page);
  const streams = createSurfaceStreams();
  assert.equal(await streams.start(win), true);
  assert.equal(page.options.maxWidth, 640);
  page.emit("a"); page.emit("b"); page.emit("c");
  await new Promise((resolve) => setTimeout(resolve, 150));
  const last = sent[sent.length - 1][1].frame;
  assert.equal(last, `data:image/jpeg;base64,${Buffer.from(`HI${captures}`).toString("base64")}`);
  assert.ok(captures >= 1 && captures <= 3);
  await streams.stop(win);
});

test("a failed still falls back to the screencast frame", async () => {
  const page = fakePage();
  page.captureJpeg = async () => { throw new Error("boom"); };
  const { win, sent } = fakeWindow(page);
  const streams = createSurfaceStreams();
  await streams.start(win);
  page.emit("RAW");
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(sent, [["halo:surfaceFrame", { frame: "data:image/jpeg;base64,RAW" }]]);
  await streams.stop(win);
});
