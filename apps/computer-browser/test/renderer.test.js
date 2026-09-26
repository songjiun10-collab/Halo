"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../renderer/renderer.js"), "utf8");

class ElementStub {
  constructor(id = "") {
    this.id = id;
    this.dataset = {};
    this.style = { setProperty() {} };
    this.children = [];
    this.listeners = new Map();
    this.value = "";
    this.disabled = false;
    this.attributes = {};
    this.label = { textContent: "START TASK" };
  }
  addEventListener(name, callback) {
    const list = this.listeners.get(name) || [];
    list.push(callback);
    this.listeners.set(name, list);
  }
  async dispatch(name, event = {}) {
    const list = this.listeners.get(name) || [];
    for (const callback of list) await callback(event);
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  querySelector(selector) { return selector === "span" ? this.label : null; }
  setAttribute(name, value) { this.attributes[name] = value; }
  getBoundingClientRect() { return { x: 0, y: 124, width: 937, height: 571 }; }
}

const ids = [
  "shell", "connection", "connection-label", "empty-status-text", "address-form", "address",
  "origin-label", "page-title", "page-meta", "security-origin", "page-load-state", "task-prompt",
  "char-count", "task-state", "run-button", "pause-button", "stop-button", "back-button",
  "forward-button", "reload-button", "new-tab-button", "queue-list", "queue-count", "timeline",
  "web-surface", "empty-state", "toast",
];

function boot(bridge, width = 1280) {
  const elements = Object.fromEntries(ids.map((id) => [id, new ElementStub(id)]));
  elements["queue-count"].textContent = "00";
  const windowListeners = new Map();
  const document = {
    getElementById: (id) => elements[id] || null,
    createElement: (tag) => new ElementStub(tag),
    documentElement: { style: { setProperty() {} } },
  };
  elements["web-surface"].getBoundingClientRect = () => ({
    x: 0, y: 124, width: width > 680 ? width - 343 : width, height: 571,
  });
  const window = {
    haloBrowser: bridge,
    innerWidth: width,
    addEventListener(name, callback) { windowListeners.set(name, callback); },
  };
  const context = {
    window, document, URL, Date, Intl, Number, Math, String, JSON,
    TypeError, setTimeout, clearTimeout,
    ResizeObserver: class { constructor(callback) { this.callback = callback; } observe() { this.callback(); } },
  };
  vm.runInNewContext(source, context, { filename: "renderer.js" });
  return { elements, window, windowListeners };
}

function snapshot(overrides = {}) {
  return {
    page: {
      url: "https://research.example/report", title: "Research report", loadState: "ready",
      canGoBack: true, canGoForward: false, hasPage: true,
    },
    task: { id: "task-1", state: "awaiting_approval" },
    approvalQueue: [{
      id: "review-1", summary: "Open <img src=x onerror=alert(1)>", origin: "https://research.example",
      action: "navigate", reason: "Origin change requires review", createdAt: "2026-09-26T10:11:12Z",
    }],
    timeline: [{ id: "event-1", at: "2026-09-26T10:11:12Z", kind: "task", message: "Page said <script>not authority</script>", status: "review" }],
    ...overrides,
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("renders the live session snapshot as text and exposes only REVIEW decisions to the queue", async () => {
  const state = snapshot();
  const calls = [];
  let eventListener;
  const bridge = {
    layout: { headerHeight: 124, footerHeight: 25, sidePanelWidth: 342, mobileBreakpoint: 680 },
    async getSnapshot() { return state; },
    async setBrowserBounds(bounds) { calls.push(["bounds", bounds]); },
    onEvent(callback) { eventListener = callback; return () => { eventListener = null; }; },
    async approve(id) { calls.push(["approve", id]); return snapshot({ approvalQueue: [], task: { id: "task-1", state: "completed" } }); },
    async deny(id) { calls.push(["deny", id]); return snapshot({ approvalQueue: [], task: { id: "task-1", state: "completed" } }); },
  };

  const { elements, windowListeners } = boot(bridge);
  await tick();

  if (elements["connection-label"].textContent === "BRIDGE ERROR") assert.fail(elements.toast.textContent);
  assert.equal(elements["connection-label"].textContent, "RUNTIME CONNECTED");
  assert.equal(elements["page-title"].textContent, "Research report");
  assert.equal(elements["security-origin"].textContent, "ORIGIN: https://research.example");
  assert.equal(elements["task-state"].textContent, "NEEDS REVIEW");
  assert.equal(elements["queue-count"].textContent, "01");
  assert.equal(elements["queue-list"].children[0].children[1].textContent, "Open <img src=x onerror=alert(1)>");
  assert.equal(elements.timeline.children[0].children[1].textContent, "Page said <script>not authority</script>");
  assert.equal(elements["run-button"].disabled, true);
  assert.equal(JSON.stringify(calls[0]), JSON.stringify(["bounds", { x: 0, y: 124, width: 937, height: 571 }]));

  const buttons = elements["queue-list"].children[0].children[3].children;
  await buttons[0].dispatch("click");
  await buttons[1].dispatch("click");
  assert.deepEqual(calls.filter(([name]) => name !== "bounds"), [["approve", "review-1"], ["deny", "review-1"]]);

  windowListeners.get("beforeunload")();
  assert.equal(eventListener, null);
});

test("keeps agent actions disabled when the privileged bridge is absent", async () => {
  const { elements } = boot(undefined);
  elements["task-prompt"].value = "Read one public page";
  await elements["task-prompt"].dispatch("input");
  assert.equal(elements["connection-label"].textContent, "BRIDGE UNAVAILABLE");
  assert.equal(elements["run-button"].disabled, true);
  assert.equal(elements["stop-button"].disabled, true);
  assert.equal(elements["queue-count"].textContent, "00");
});

test("uses the mobile surface layout below the shared breakpoint", async () => {
  let mobileBounds;
  const bridge = {
    layout: { headerHeight: 124, footerHeight: 25, sidePanelWidth: 342, mobileBreakpoint: 680 },
    async getSnapshot() { return snapshot(); },
    async setBrowserBounds(bounds) { mobileBounds = bounds; },
    onEvent() { return () => {}; },
  };
  const { elements } = boot(bridge, 390);
  await tick();
  assert.equal(elements.shell.dataset.mobile, "true");
  assert.equal(JSON.stringify(mobileBounds), JSON.stringify({ x: 0, y: 124, width: 390, height: 571 }));
});

test("fails closed when the preload returns a malformed session snapshot", async () => {
  const bridge = {
    layout: { headerHeight: 124, footerHeight: 25, sidePanelWidth: 342, mobileBreakpoint: 680 },
    async getSnapshot() { return { page: null, task: {}, approvalQueue: [], timeline: [] }; },
    async setBrowserBounds() {},
    onEvent() { return () => {}; },
  };
  const { elements } = boot(bridge);
  await tick();
  assert.equal(elements["connection-label"].textContent, "BRIDGE ERROR");
  assert.equal(elements["new-tab-button"].disabled, true);
  assert.equal(elements["run-button"].disabled, true);
});

test("fails closed when the privileged bridge omits shared layout constants", async () => {
  const bridge = {
    async getSnapshot() { return snapshot(); },
    async setBrowserBounds() { assert.fail("must not position a native view without the shared layout contract"); },
    onEvent() { return () => {}; },
  };
  const { elements } = boot(bridge);
  await tick();
  assert.equal(elements["connection-label"].textContent, "BRIDGE ERROR");
  assert.equal(elements["new-tab-button"].disabled, true);
  assert.equal(elements["run-button"].disabled, true);
});
