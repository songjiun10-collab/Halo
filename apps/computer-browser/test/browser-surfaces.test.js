"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { BrowserSurfaces } = require("../main/harness/browser-surfaces");

function setup(options = {}) {
  const win = new EventEmitter();
  let size = [800, 600];
  const children = new Set();
  Object.assign(win, { isDestroyed: () => false, getContentSize: () => size,
    contentView: { addChildView: v => children.add(v), removeChildView: v => children.delete(v) } });
  let controlled = false;
  const surfaces = new BrowserSurfaces(win, { isUserControlled: () => controlled, ...options });
  function view() {
    const webContents = new EventEmitter();
    webContents.isDestroyed = () => false;
    return { webContents, visible: false, bounds: null,
      setVisible(v) { this.visible = v; }, setBounds(b) { this.bounds = b; } };
  }
  return { win, surfaces, children, view, resize(w,h) { size = [w,h]; win.emit("resize"); }, control(v) { controlled = v; } };
}

test("only the selected native task is visible and modal hide clears every surface", () => {
  const { surfaces, view } = setup();
  const a = view(), b = view();
  surfaces.register("a", a); surfaces.register("b", b);
  const bounds = { x:12, y:100, width:776, height:488, visible:true };
  surfaces.setViewport("a", bounds);
  assert.equal(a.visible, true); assert.equal(b.visible, false);
  surfaces.setViewport("b", bounds);
  assert.equal(a.visible, false); assert.equal(b.visible, true);
  surfaces.setViewport(null, { x:0,y:0,width:0,height:0,visible:false });
  assert.equal(a.visible, false); assert.equal(b.visible, false);
});

test("bounds cannot cover toolbar or extend outside resized window", () => {
  const { surfaces, view, resize } = setup();
  const a = view(); surfaces.register("a", a);
  surfaces.setViewport("a", { x:-100,y:-100,width:2000,height:2000,visible:true });
  assert.deepEqual(a.bounds, { x:0,y:94,width:800,height:506 });
  resize(500,400);
  assert.deepEqual(a.bounds, { x:0,y:94,width:500,height:306 });
  assert.throws(() => surfaces.setViewport("a", {x:NaN,y:0,width:1,height:1,visible:true}));
  assert.throws(() => surfaces.setViewport("missing", {x:0,y:100,width:1,height:1,visible:true}));
});

test("native keyboard/mouse input is denied until human takeover is drained", () => {
  const { surfaces, view, control } = setup();
  const a = view(); surfaces.register("a", a);
  surfaces.setViewport("a", {x:0,y:100,width:800,height:500,visible:true});
  let blocked = 0;
  const e = { preventDefault: () => blocked++ };
  a.webContents.emit("before-input-event", e);
  a.webContents.emit("before-mouse-event", e);
  assert.equal(blocked, 2);
  control(true);
  a.webContents.emit("before-mouse-event", e);
  assert.equal(blocked, 2);
  surfaces.setViewport(null, {x:0,y:0,width:0,height:0,visible:false});
  a.webContents.emit("before-input-event", e);
  assert.equal(blocked, 3);
});

test("reattaching replaces old view and stale disposal cannot remove replacement", () => {
  const { surfaces, view, children } = setup();
  const old = view(), fresh = view();
  surfaces.register("a", old); surfaces.register("a", fresh);
  old.webContents.emit("destroyed");
  surfaces.setViewport("a", {x:0,y:100,width:800,height:500,visible:true});
  assert.equal(fresh.visible, true); assert.equal(children.has(old), false);
  fresh.webContents.emit("destroyed");
  assert.equal(children.size, 0);
});

test("find, zoom and copy flow only while the user owns the task, and copy uses the injected writer", async () => {
  const written = [];
  const { surfaces, view, control } = setup({ writeClipboard: (text) => { written.push(text); return true; } });
  const a = view();
  a.webContents.executeJavaScript = async (code) => {
    if (code.includes("window.find")) return true;
    if (code.includes("style.zoom")) return "1.1";
    if (code.includes("getSelection")) return "selected words";
    return null;
  };
  surfaces.register("a", a);

  assert.equal((await surfaces.findInPage("a", "x")).errorCode, "surface_unavailable");
  assert.equal((await surfaces.setZoom("a", { direction: "in" })).errorCode, "surface_unavailable");
  assert.equal((await surfaces.copySelection("a")).errorCode, "surface_unavailable");

  control(true);
  assert.deepEqual(await surfaces.findInPage("a", "x"), { ok: true, found: true });
  assert.deepEqual(await surfaces.setZoom("a", { direction: "in" }), { ok: true, level: 1.1 });
  const copied = await surfaces.copySelection("a");
  assert.equal(copied.ok, true);
  assert.equal(copied.chars, "selected words".length);
  assert.deepEqual(written, ["selected words"], "the injected writer received the selection, not the system clipboard");

  // A zoom stored for the task re-applies after a navigation on the surface.
  let reapplied = null;
  a.webContents.executeJavaScript = async (code) => { reapplied = code; return "1.1"; };
  a.webContents.emit("did-navigate");
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(reapplied && reapplied.includes('style.zoom = "1.1"'));
});
