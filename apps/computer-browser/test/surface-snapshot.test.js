"use strict";

// The renderer hides the native page while a Halo overlay is open (a native
// view always draws above the DOM). Before hiding it, it asks for a still
// image of exactly what is showing, so the page does not vanish.

const test = require("node:test");
const assert = require("node:assert/strict");
const { captureVisibleSurface } = require("../main/surface-snapshot");
const registerIpc = require("../main/ipc");

function fakeImage(width, height) {
  const calls = [];
  const image = {
    calls,
    isEmpty: () => width === 0 || height === 0,
    getSize: () => ({ width, height }),
    resize: (opts) => { calls.push(["resize", opts]); return fakeImage(opts.width, Math.round(height * opts.width / width)); },
    toJPEG: (quality) => { calls.push(["toJPEG", quality]); return Buffer.from(`jpeg:${width}x${height}`); },
  };
  return image;
}

function fakeView({ visible = true, bounds = { x: 0, y: 94, width: 800, height: 600 }, image = fakeImage(800, 600), destroyed = false } = {}) {
  let captured = 0;
  return {
    getVisible: () => visible,
    getBounds: () => bounds,
    webContents: { isDestroyed: () => destroyed, capturePage: async () => { captured += 1; return image; } },
    get captured() { return captured; },
  };
}

const winWith = (...children) => ({ isDestroyed: () => false, contentView: { children } });

test("captures the one visible page view as a JPEG data URL", async () => {
  const hidden = fakeView({ visible: false });
  const shown = fakeView();
  const result = await captureVisibleSurface(winWith(hidden, shown));
  assert.equal(result, `data:image/jpeg;base64,${Buffer.from("jpeg:800x600").toString("base64")}`);
  assert.equal(hidden.captured, 0);
  assert.equal(shown.captured, 1);
});

test("a view parked at zero size counts as hidden", async () => {
  const parked = fakeView({ bounds: { x: 0, y: 94, width: 0, height: 0 } });
  assert.equal(await captureVisibleSurface(winWith(parked)), null);
  assert.equal(parked.captured, 0);
});

test("nothing visible, a destroyed page or an empty capture yields null", async () => {
  assert.equal(await captureVisibleSurface(winWith()), null);
  assert.equal(await captureVisibleSurface(winWith(fakeView({ destroyed: true }))), null);
  assert.equal(await captureVisibleSurface(winWith(fakeView({ image: fakeImage(0, 0) }))), null);
  assert.equal(await captureVisibleSurface({ isDestroyed: () => true, contentView: { children: [fakeView()] } }), null);
});

test("a large capture is scaled down before encoding", async () => {
  const image = fakeImage(3200, 2000);
  await captureVisibleSurface(winWith(fakeView({ image })));
  assert.deepEqual(image.calls[0], ["resize", { width: 1600, quality: "good" }]);
});

test("a failed capture yields null rather than an error", async () => {
  const view = fakeView();
  view.webContents.capturePage = async () => { throw new Error("gone"); };
  assert.equal(await captureVisibleSurface(winWith(view)), null);
});

test("captureSurface is answered only for the trusted Halo window", async () => {
  const handlers = new Map();
  const ipcMain = { handle: (c, fn) => handlers.set(c, fn), removeHandler: (c) => handlers.delete(c) };
  const mainFrame = { url: "file:///app/renderer/index.html" };
  const win = {
    ...winWith(fakeView()),
    webContents: { mainFrame, send() {} },
    on() {},
  };
  registerIpc(win, { onChange: () => () => {} }, { ipcMain });
  const result = await handlers.get("halo:captureSurface")({ senderFrame: mainFrame });
  assert.match(result, /^data:image\/jpeg;base64,/);
  await assert.rejects(handlers.get("halo:captureSurface")({ senderFrame: { url: "https://attacker.example/" } }), /rejected untrusted sender/);
});
