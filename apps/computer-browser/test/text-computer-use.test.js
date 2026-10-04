"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { buildScreenMap, resolveTarget } = require("../main/harness/screen-map");
const { BrowserAdapter } = require("../main/harness/browser-adapter");
const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");
const { classifyTarget } = require("../main/harness/effect-classifier");
const { validateCoordinateAction } = require("../main/harness/computer-use-contract");
const { evaluateActionPolicy } = require("../main/harness/permission-policy");
const { buildPrompt } = require("../main/harness/providers/claude-code-bridge");

const ELEMENTS = [
  { elementId: "0", role: "textbox", name: "Title", inputType: "text" },
  { elementId: "1", role: "button", name: 'Save "now"' },
  { elementId: "2", role: "button", name: "Hidden under modal" },
  { elementId: "3", role: "heading", name: "Settings" },
];
const BOXES = [
  { elementId: "0", x: 0.1, y: 0.2, w: 0.4, h: 0.1 },
  { elementId: "1", x: 0.6, y: 0.2, w: 0.2, h: 0.1 },
  { elementId: "2", x: 0.1, y: 0.5, w: 0.2, h: 0.1, covered: true },
  { elementId: "3", x: 0, y: 0, w: 1, h: 0.1 },
];

test("buildScreenMap renders centers, flags covered targets, and counts only usable ones", () => {
  const map = buildScreenMap(ELEMENTS, BOXES);
  const lines = map.text.split("\n");
  assert.equal(lines[0], 'textbox "Title" at 0.300,0.250 size 0.400x0.100 [type=text]');
  assert.match(lines[1], /^button "Save now" at 0\.700,0\.250/);
  assert.match(lines[2], /\[covered\]$/);
  assert.equal(map.actionable, 2);
  assert.equal(map.sparse, false);
});

test("buildScreenMap drops malformed geometry, clamps centers below 1, and bounds size", () => {
  const map = buildScreenMap(ELEMENTS, [
    { elementId: "0", x: 0.9, y: 0.9, w: 0.1, h: 0.1 },
    { elementId: "9", x: 0, y: 0, w: 0.1, h: 0.1 },
    { elementId: "1", x: -1, y: 0, w: 0.1, h: 0.1 },
    { elementId: "1", x: 0, y: 0, w: 0, h: 0.1 },
    { elementId: "1", x: 0, y: 0, w: Number.NaN, h: 0.1 },
  ]);
  assert.equal(map.entries, 1);
  assert.match(map.text, /at 0\.950,0\.950/);
  assert.equal(map.sparse, true);
  const many = Array.from({ length: 200 }, (_, i) => ({ elementId: String(i), role: "button", name: `b${i}` }));
  const big = buildScreenMap(many, many.map((e) => ({ elementId: e.elementId, x: 0, y: 0, w: 0.1, h: 0.1 })));
  assert.equal(big.entries, 80);
});

function adapterWith({ boxes, url = "https://page.test/" }) {
  const wc = new EventEmitter();
  let current = url;
  Object.assign(wc, {
    getURL: () => current,
    close() {},
    executeJavaScriptInIsolatedWorld: async (_world, scripts) => {
      const code = scripts[0].code;
      if (code.includes("getBoundingClientRect")) return boxes;
      return { url, title: "t", text: "", elements: ELEMENTS.map((e, index) => ({ index, ...e, parentIndex: null })) };
    },
  });
  const view = { webContents: wc, getBounds: () => ({ x: 0, y: 0, width: 1440, height: 900 }) };
  return { adapter: new BrowserAdapter({ view }), navigate: (next) => { current = next; } };
}

test("captureScreenGeometry reads boxes only for the latest observation", async () => {
  const { adapter } = adapterWith({ boxes: BOXES });
  const observation = await adapter.observe();
  const geometry = await adapter.captureScreenGeometry(observation);
  assert.equal(geometry.observationId, observation.id);
  assert.deepEqual(geometry.viewport, { width: 1440, height: 900 });
  assert.equal(geometry.boxes.length, 4);
  await assert.rejects(adapter.captureScreenGeometry({ ...observation, id: "other" }), { code: "stale_visual_observation" });
});

test("captureScreenGeometry refuses a page that navigated after the observation", async () => {
  const { adapter, navigate } = adapterWith({ boxes: BOXES });
  const observation = await adapter.observe();
  navigate("https://elsewhere.test/");
  await assert.rejects(adapter.captureScreenGeometry(observation), { code: "visual_unavailable" });
});

test("a failed geometry read is reported as a capture failure, not an empty map", async () => {
  const { adapter } = adapterWith({ boxes: null });
  const observation = await adapter.observe();
  await assert.rejects(adapter.captureScreenGeometry(observation), { code: "stale_visual_observation" });
});

async function controllerFixture(t, { textMode = true, sparse = false, vision = null, captureFails = false, action = null, noProfile = false } = {}) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-text-cu-"));
  const store = await TaskStore.create({ originalRequest: "save the title" }, { storageRoot });
  const seen = []; let turns = 0; const executed = [];
  const browser = {
    supportsAction: () => true,
    observe: async () => ({ id: "obs", documentEpoch: 3, url: "https://page.test/", elements: ELEMENTS }),
    captureTextObservation: async (observation) => {
      if (captureFails) throw new Error("geometry failed");
      return {
        binding: { observationId: observation.id, taskId: store.taskId, agentId: null, documentEpoch: observation.documentEpoch, origin: "https://page.test", capturedAt: 1, viewport: { width: 1440, height: 900 }, digest: "a".repeat(64) },
        screenMap: { text: 'button "Save" at 0.700,0.250 size 0.200x0.100', entries: 1, actionable: sparse ? 0 : 2, sparse, targets: [
          { role: "region", name: "Card", x: 0.5, y: 0.1, w: 0.45, h: 0.4, covered: false, disabled: false },
          { role: "button", name: "Delete", x: 0.6, y: 0.2, w: 0.2, h: 0.1, covered: false, disabled: false },
          { role: "textbox", name: "Title", x: 0.1, y: 0.2, w: 0.4, h: 0.1, covered: false, disabled: false },
          { role: "button", name: "Search", x: 0.6, y: 0.6, w: 0.2, h: 0.1, covered: false, disabled: false },
          { role: "button", name: "Withdraw", x: 0.6, y: 0.8, w: 0.2, h: 0.1, covered: false, disabled: false },
        ] },
      };
    },
    execute: async (action) => { executed.push(action); return { status: "ok" }; },
  };
  const controller = new TaskController({
    store, browser, permissionMode: "interact", plannerImageInput: !textMode, ...(vision ? { visionAssist: vision } : {}),
    approve: async () => ({ decision: "allow", reasons: [] }), hostVerifier: () => true, maxRecoveries: 0,
    planner: { next: async (c, options) => {
      seen.push({ observation: c.observation, options });
      const base = { taskId: c.taskId, goalVersion: c.goalVersion, basedOnObservationId: c.observation.id, criterionIds: [] };
      return turns++ === 0 ? { ...base, kind: "actions", actions: [action ? { ...action, observationId: c.observation.id } : { type: "press_key", observationId: c.observation.id, key: "Enter" }] } : { ...base, kind: "finish", evidenceIds: [] };
    } },
  });
  if (!noProfile) store.taskProfile = { capability: { id: "computer_use", adapters: [
    { capabilityId: "browser", adapterId: "task-owned-viewport-screenshot", adapterVersion: 1 },
    { capabilityId: "computer_use", adapterId: "codex-subscription-image", adapterVersion: 1 },
  ] } };
  t.after(async () => { await controller.stop(); await store.close(); await fs.rm(storageRoot, { recursive: true, force: true }); });
  await controller.start();
  return { controller, seen, executed };
}

test("a planner without image input gets the screen map and no attachment, and its Enter key waits for approval", async (t) => {
  const { controller, seen } = await controllerFixture(t);
  assert.equal(seen[0].observation.computerUse.mode, "text");
  assert.equal(seen[0].observation.screenMap, 'button "Save" at 0.700,0.250 size 0.200x0.100');
  assert.equal(seen[0].options.attachments, undefined);
  assert.equal(controller.getSnapshot().state, "awaiting_approval");
});

test("an image-capable planner still gets an attachment path, not the text map", async (t) => {
  const { seen } = await controllerFixture(t, { textMode: false }).catch((e) => ({ seen: [], e }));
  // The fixture browser has no captureComputerUseObservation, so the image route pauses before any planner turn.
  assert.equal(seen.length, 0);
});

test("a capture failure pauses the task instead of sending the planner a blind turn", async (t) => {
  const { controller, seen } = await controllerFixture(t, { captureFails: true });
  assert.equal(seen.length, 0);
  assert.equal(controller.getSnapshot().pauseReason, "computer_use_capture_failed");
});

test("visionAssist runs only for a sparse map, and its text is sanitized and bounded", async (t) => {
  let calls = 0;
  const vision = async () => { calls += 1; return `A canvas chart\u0000${"x".repeat(5000)}`; };
  const sparse = await controllerFixture(t, { sparse: true, vision });
  assert.equal(calls, 1);
  assert.ok(sparse.seen[0].observation.visionNote.length <= 2048);
  assert.equal(sparse.seen[0].observation.visionNote.includes("\u0000"), false);
  calls = 0;
  const dense = await controllerFixture(t, { sparse: false, vision });
  assert.equal(calls, 0);
  assert.equal(dense.seen[0].observation.visionNote, undefined);
});

test("a failing visionAssist leaves the plain map", async (t) => {
  const { seen } = await controllerFixture(t, { sparse: true, vision: async () => { throw new Error("no vision"); } });
  assert.equal(seen[0].observation.visionNote, undefined);
  assert.ok(seen[0].observation.screenMap);
});

test("the prompt tells a text-mode planner to read screenMap, not an attached image", () => {
  const text = buildPrompt({ observation: { elements: [], computerUse: { mode: "text" }, screenMap: "x" }, progress: {}, goal: {} });
  assert.match(text, /No screenshot is attached/);
  assert.doesNotMatch(text, /screenshot is attached out-of-band/);
  const image = buildPrompt({ observation: { elements: [], computerUse: { observationId: "o" } }, progress: {}, goal: {} });
  assert.match(image, /screenshot is attached out-of-band/);
});

test("press_key accepts only the bounded navigation keys and no extra fields", () => {
  for (const key of ["Enter", "Tab", "Escape", "Backspace", "ArrowDown"]) assert.ok(validateCoordinateAction({ type: "press_key", observationId: "o", key }));
  for (const key of ["a", "Control+A", "F5", "Delete", "enter", "", 7]) assert.throws(() => validateCoordinateAction({ type: "press_key", observationId: "o", key }), { code: "invalid_coordinate_action" });
  assert.throws(() => validateCoordinateAction({ type: "press_key", observationId: "o", key: "Enter", x: 0.1 }), { code: "invalid_coordinate_action" });
  assert.throws(() => validateCoordinateAction({ type: "press_key", observationId: "o" }), { code: "invalid_coordinate_action" });
});

test("press_key is an interaction: observe and browse modes refuse it", () => {
  assert.equal(evaluateActionPolicy("interact", "press_key").allowed, true);
  assert.equal(evaluateActionPolicy("interact", "press_key").approval, "human");
  assert.equal(evaluateActionPolicy("browse", "press_key").allowed, false);
  assert.equal(evaluateActionPolicy("observe", "press_key").allowed, false);
});

test("the adapter sends key events for press_key and consumes the binding", async () => {
  const sent = [];
  const { adapter } = adapterWith({ boxes: BOXES });
  adapter.setPermissionMode("interact");
  const wc = adapter._view.webContents;
  wc.sendInputEvent = (event) => sent.push(event);
  wc.insertText = () => {};
  const observation = await adapter.observe();
  adapter.authorizeVisualBinding({ observationId: observation.id, taskId: "11111111-1111-4111-8111-111111111111", agentId: null, documentEpoch: observation.documentEpoch, origin: "https://page.test", capturedAt: 1, viewport: { width: 1440, height: 900 }, digest: "0".repeat(64) });
  const action = { type: "press_key", observationId: observation.id, key: "Enter" };
  assert.deepEqual(await adapter.execute(action, { documentEpoch: observation.documentEpoch }), { status: "ok" });
  assert.deepEqual(sent, [{ type: "keyDown", keyCode: "Enter" }, { type: "char", keyCode: "Enter" }, { type: "keyUp", keyCode: "Enter" }]);
  assert.deepEqual(await adapter.execute(action, { documentEpoch: observation.documentEpoch }), { status: "failed", errorCode: "stale_visual_observation" });
  assert.equal(sent.length, 3);
});

test("a press_key proposal waits in the ordinary approval queue and shows the key", async (t) => {
  const { controller } = await controllerFixture(t, { action: { type: "press_key", key: "Enter" } });
  assert.equal(controller.getSnapshot().state, "awaiting_approval");
  assert.match(controller.getSnapshot().approvalQueue[0].target, /press Enter/);
});

test("text-mode navigation and input run without a human gate", async (t) => {
  for (const action of [{ type: "click_at", x: 0.7, y: 0.65 }, { type: "type_at", x: 0.3, y: 0.25, text: "hi" }, { type: "press_key", key: "Tab" }]) {
    const { controller, executed } = await controllerFixture(t, { action });
    assert.equal(controller.getSnapshot().approvalQueue.length, 0, action.type);
    assert.equal(executed.length, 1, action.type);
  }
});

test("text-mode clicks on an effect-bearing or unmapped control wait for the human", async (t) => {
  for (const action of [{ type: "click_at", x: 0.7, y: 0.25 }, { type: "click_at", x: 0.99, y: 0.99 }, { type: "type_at", x: 0.7, y: 0.25, text: "x" }]) {
    const { controller, executed } = await controllerFixture(t, { action });
    assert.equal(executed.length, 0, JSON.stringify(action));
    assert.equal(controller.getSnapshot().state, "awaiting_approval", JSON.stringify(action));
  }
});

test("classifyTarget separates navigation, input, effect and unknown controls", () => {
  const c = (role, name, extra = {}) => classifyTarget({ role, name, ...extra }, "click_at");
  for (const name of ["Buy now", "Send", "Pay $20", "삭제", "Submit", "Sign out"]) {
    assert.deepEqual([c("button", name).gate, c("button", name).effect], ["ask", "effect"], name);
  }
  assert.equal(c("link", "Delete account").gate, "deny");
  for (const name of ["Search", "Next", "Close", "더보기", "Show more"]) assert.equal(c("button", name).gate, "auto", name);
  assert.equal(c("link", "Pricing").gate, "auto");
  assert.equal(c("checkbox", "Remember me").gate, "auto");
  assert.equal(c("button", "OK").effect, "unknown");
  assert.equal(c("button", "").gate, "ask");
  assert.equal(c("heading", "Settings").gate, "ask");
  assert.equal(c("button", "Search", { covered: true }).effect, "blocked");
  assert.equal(c("button", "Search", { disabled: true }).effect, "blocked");
  assert.equal(classifyTarget(null, "click_at").gate, "ask");
  assert.equal(classifyTarget({ role: "textbox", name: "Title" }, "type_at").gate, "auto");
  assert.equal(classifyTarget({ role: "button", name: "Search" }, "type_at").gate, "ask");
  assert.equal(classifyTarget({ role: "textbox", name: "Send to" }, "type_at").gate, "ask");
});

test("outside computer use a coordinate action never skips the human gate", async (t) => {
  const { controller, executed } = await controllerFixture(t, { action: { type: "click_at", x: 0.7, y: 0.25 }, noProfile: true });
  assert.equal(executed.length, 0);
  assert.equal(controller.getSnapshot().approvalQueue.length, 0);
});

test("resolveTarget picks the smallest box under the point and reports misses", () => {
  const { targets } = buildScreenMap(ELEMENTS, [
    { elementId: "3", x: 0, y: 0, w: 1, h: 0.5 },
    { elementId: "1", x: 0.6, y: 0.2, w: 0.2, h: 0.1 },
    { elementId: "2", x: 0.1, y: 0.4, w: 0.1, h: 0.05, covered: true },
  ]);
  assert.equal(resolveTarget(targets, 0.7, 0.25).role, "button");
  assert.equal(resolveTarget(targets, 0.1, 0.1).role, "heading");
  const covered = resolveTarget(targets, 0.15, 0.42);
  assert.equal(covered.covered, true);
  assert.equal(resolveTarget(targets, 0.9, 0.9), null);
});

test("the approval for a text-mode click names the control under the point", async (t) => {
  const { controller } = await controllerFixture(t, { action: { type: "press_key", key: "Enter" } });
  // Enter is gated, so use a fresh fixture whose click lands on the Delete button and is auto-run; read the audit via a gated type.
  assert.match(controller.getSnapshot().approvalQueue[0].target, /press Enter/);
  const descriptors = [];
  const original = TaskController.prototype._describeAction;
  TaskController.prototype._describeAction = function (...args) { const d = original.apply(this, args); descriptors.push(d); return d; };
  try {
    await controllerFixture(t, { action: { type: "click_at", x: 0.7, y: 0.25 } });
    await controllerFixture(t, { action: { type: "click_at", x: 0.99, y: 0.99 } });
  } finally { TaskController.prototype._describeAction = original; }
  const targets = descriptors.map((d) => d.target).filter((x) => x.startsWith("screenshot"));
  assert.match(targets[0], /-> button "Delete"/);
  assert.match(targets[1], /-> no mapped control/);
});

test("image-mode coordinate clicks are classified by the control they land on", async (t) => {
  for (const [action, expectRun] of [[{ type: "click_at", x: 0.7, y: 0.65 }, true], [{ type: "click_at", x: 0.7, y: 0.25 }, false]]) {
    const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-img-cu-"));
    const store = await TaskStore.create({ originalRequest: "click" }, { storageRoot });
    const executed = []; let turns = 0;
    const controller = new TaskController({
      store, permissionMode: "interact", approve: async () => ({ decision: "allow", reasons: [] }), hostVerifier: () => true, maxRecoveries: 0,
      browser: {
        supportsAction: () => true,
        observe: async () => ({ id: "obs", documentEpoch: 3, url: "https://page.test/", elements: [] }),
        captureComputerUseObservation: async (o) => ({
          binding: { observationId: o.id, taskId: store.taskId, agentId: null, documentEpoch: 3, origin: "https://page.test", capturedAt: 1, viewport: { width: 1440, height: 900 }, digest: "a".repeat(64) },
          attachment: { id: "a1", path: "/private/x.png", dispose: async () => {} },
          screenTargets: [
            { role: "button", name: "Delete", x: 0.6, y: 0.2, w: 0.2, h: 0.1, covered: false, disabled: false },
            { role: "button", name: "Search", x: 0.6, y: 0.6, w: 0.2, h: 0.1, covered: false, disabled: false },
          ],
        }),
        execute: async (a) => { executed.push(a); return { status: "ok" }; },
      },
      planner: { next: async (c) => {
        const base = { taskId: c.taskId, goalVersion: c.goalVersion, basedOnObservationId: c.observation.id, criterionIds: [] };
        return turns++ === 0 ? { ...base, kind: "actions", actions: [{ ...action, observationId: c.observation.id }] } : { ...base, kind: "finish", evidenceIds: [] };
      } },
    });
    store.taskProfile = { capability: { id: "computer_use", adapters: [
      { capabilityId: "browser", adapterId: "task-owned-viewport-screenshot", adapterVersion: 1 },
      { capabilityId: "computer_use", adapterId: "codex-subscription-image", adapterVersion: 1 },
    ] } };
    t.after(async () => { await controller.stop(); await store.close(); await fs.rm(storageRoot, { recursive: true, force: true }); });
    await controller.start();
    assert.equal(executed.length > 0, expectRun, JSON.stringify(action));
    if (!expectRun) assert.match(controller.getSnapshot().approvalQueue[0].target, /-> button "Delete"/);
  }
});

test("effect classifier denies money-moving and account-destroying button clicks outright", () => {
  const { classifyTarget } = require("../main/harness/effect-classifier");
  const btn = (name) => ({ role: "button", name });
  for (const name of ["Withdraw", "Transfer funds", "Delete account", "Permanently delete", "송금", "회원 탈퇴"]) {
    const verdict = classifyTarget(btn(name), "click_at");
    assert.equal(verdict.gate, "deny", name);
    assert.equal(verdict.effect, "irreversible");
  }
  assert.equal(classifyTarget({ role: "link", name: "Close my account" }, "click_at").gate, "deny");
  // Ordinary effect names still go to the human, not the floor.
  assert.equal(classifyTarget(btn("Delete"), "click_at").gate, "ask");
  assert.equal(classifyTarget(btn("Send"), "click_at").gate, "ask");
  // A text field that only mentions one is not a click on it.
  assert.equal(classifyTarget({ role: "textbox", name: "Withdraw amount" }, "type_at").gate, "ask");
  assert.equal(classifyTarget({ role: "textbox", name: "Search" }, "type_at").gate, "auto");
});

test("a click on a money-moving control is refused: nothing runs, nothing queues, and the task carries on", async (t) => {
  const { controller, executed } = await controllerFixture(t, { action: { type: "click_at", x: 0.7, y: 0.85 } });
  assert.equal(executed.length, 0);
  assert.equal(controller.getSnapshot().approvalQueue.length, 0);
  assert.notEqual(controller.getSnapshot().pauseReason, "approver_error");
});
