"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { OsComputerUse, FakeOsBackend } = require("../main/harness/os-computer-use");

const window = { app: "Notes", bundleId: "com.apple.Notes", title: "Shopping", pid: 42 };
const controls = [
  { role: "link", name: "Open folder", x: 0.1, y: 0.1, w: 0.2, h: 0.1 },
  { role: "button", name: "Delete note", x: 0.5, y: 0.1, w: 0.2, h: 0.1 },
  { role: "textbox", name: "Body", x: 0.1, y: 0.4, w: 0.8, h: 0.4, focused: true },
  { role: "textbox", name: "Password", x: 0.1, y: 0.85, w: 0.8, h: 0.1, secure: true },
];
const make = (extra = {}, backendExtra = {}) => {
  const backend = new FakeOsBackend({ window, controls, ...backendExtra });
  const journal = [];
  const cu = new OsComputerUse({ backend, allowedApps: ["com.apple.Notes"], journal: async (e) => journal.push(e), ...extra });
  return { backend, cu, journal };
};

test("an unlisted app is refused at observe and the backend is never driven", async () => {
  const { cu, backend } = make({ allowedApps: [] });
  const seen = await cu.observe();
  assert.equal(seen.errorCode, "os_denied");
  assert.equal((await cu.execute({ type: "os_click_at", observationId: "x", x: 0.2, y: 0.15 })).errorCode, "stale_os_observation");
  assert.deepEqual(backend.calls, []);
});

test("an automatic click runs, is journalled first, and spends the observation", async () => {
  const { cu, backend, journal } = make();
  const { observation } = await cu.observe();
  assert.equal(observation.authority, "untrusted_page_derived");
  const result = await cu.execute({ type: "os_click_at", observationId: observation.id, x: 0.2, y: 0.15 });
  assert.equal(result.status, "ok");
  assert.deepEqual(backend.calls, [["click", 0.2, 0.15]]);
  assert.equal(journal.length, 1);
  assert.equal(cu.actionsUsed, 1);
  assert.equal((await cu.execute({ type: "os_click_at", observationId: observation.id, x: 0.2, y: 0.15 })).errorCode, "stale_os_observation");
});

test("an effect click waits for approval; without it nothing runs, with it the click runs", async () => {
  const denied = make();
  const o1 = (await denied.cu.observe()).observation;
  const waiting = await denied.cu.execute({ type: "os_click_at", observationId: o1.id, x: 0.6, y: 0.15 });
  assert.equal(waiting.errorCode, "os_needs_approval");
  assert.deepEqual(denied.backend.calls, []);
  const asked = [];
  const approved = make({ approve: async (q) => { asked.push(q.reason); return true; } });
  const o2 = (await approved.cu.observe()).observation;
  assert.equal((await approved.cu.execute({ type: "os_click_at", observationId: o2.id, x: 0.6, y: 0.15 })).status, "ok");
  assert.equal(asked.length, 1);
});

test("typing: into the focused text field only; secure field click is refused", async () => {
  const { cu, backend } = make();
  const o = (await cu.observe()).observation;
  assert.equal((await cu.execute({ type: "os_type_text", observationId: o.id, text: "milk" })).status, "ok");
  assert.deepEqual(backend.calls, [["type", "milk"]]);
  const o2 = (await cu.observe()).observation;
  assert.equal((await cu.execute({ type: "os_click_at", observationId: o2.id, x: 0.5, y: 0.9 })).errorCode, "os_denied");
});

test("a window that changed since the observation makes it stale", async () => {
  const { cu, backend } = make();
  const o = (await cu.observe()).observation;
  backend.window = { ...window, title: "Other note" };
  assert.equal((await cu.execute({ type: "os_click_at", observationId: o.id, x: 0.2, y: 0.15 })).errorCode, "stale_os_observation");
  assert.deepEqual(backend.calls, []);
});

test("bad coordinates, empty text and unknown action types are rejected without touching the backend", async () => {
  const { cu, backend } = make();
  const o = (await cu.observe()).observation;
  assert.equal((await cu.execute({ type: "os_click_at", observationId: o.id, x: 2, y: 0 })).errorCode, "invalid_os_action");
  assert.equal((await cu.execute({ type: "os_type_text", observationId: o.id, text: "" })).errorCode, "invalid_os_action");
  assert.equal((await cu.execute({ type: "os_launch", observationId: o.id })).errorCode, "unsupported_action");
  assert.deepEqual(backend.calls, []);
});

test("the action limit stops a run", async () => {
  const { cu } = make({ maxActions: 1 });
  const a = (await cu.observe()).observation;
  assert.equal((await cu.execute({ type: "os_press_key", observationId: a.id, key: "ArrowDown" })).status, "ok");
  assert.equal((await cu.observe()).errorCode, "os_denied");
});
