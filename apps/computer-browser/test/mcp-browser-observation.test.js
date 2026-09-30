"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { makeMcpBrowserObservation } = require("../main/harness/mcp-browser-observation");

const FILE_URL = "https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md";
const DOM_TEXT = "GitHub chrome ".repeat(400);

function domObservation(overrides = {}) {
  return {
    id: "obs-1", documentEpoch: 3, url: FILE_URL, title: "README.md", text: DOM_TEXT,
    elements: [
      { elementId: "0", parentElementId: null, role: "link", href: "https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/a.md" },
      { elementId: "1", parentElementId: "0", role: "link", href: "https://github.com/deepseek-ai/deepseek-harness/tree/master/docs" },
      { elementId: "2", parentElementId: "5", role: "link", href: "https://github.com/deepseek-ai/deepseek-harness/blob/master/b.md" },
      { elementId: "5", parentElementId: null, role: "navigation", href: "https://github.com/settings" },
      { elementId: "6", parentElementId: null, role: "button" },
    ],
    at: 1,
    ...overrides,
  };
}

function fakeBrowser(state = {}) {
  const browser = {
    epoch: 3, url: FILE_URL, disposed: false, observation: domObservation(),
    getDocumentEpoch() { return this.epoch; },
    getBrowserSnapshot() { return { tabs: [{ id: "page", url: this.url }], activeTabId: "page", documentEpoch: this.epoch }; },
    async observe() { return this.observation; },
    async execute(action) { return this.executeResult || { status: "ok", action, observation: this.observation }; },
    async dispose() { this.disposed = true; },
    ...state,
  };
  return browser;
}

function connectorResult(overrides = {}) {
  return { text: "# README\n", truncated: false, sourceBytes: 9, authority: "untrusted_connector", sourceUrl: FILE_URL,
    server: "codex_apps", tool: "github.fetch_file", latencyMs: 12, range: { startLine: 1, endLine: 100 }, ...overrides };
}

function setup({ browser = fakeBrowser(), readFile, deadlineMs } = {}) {
  const metrics = [];
  const calls = [];
  const connector = { readFile: readFile || (async (url, options) => { calls.push({ url, options }); return connectorResult(); }) };
  const wrapped = makeMcpBrowserObservation({ browser, connector, onMetric: (m) => metrics.push(m), ...(deadlineMs ? { deadlineMs } : {}) });
  return { browser, wrapped, metrics, calls, connector };
}

test("a matching GitHub file observation is replaced by connector text with provenance", async () => {
  const { wrapped, metrics, calls } = setup();
  const observation = await wrapped.observe();
  assert.equal(calls.length, 1);
  assert.equal(observation.text, "# README\n");
  assert.equal(observation.id, "obs-1");
  assert.equal(observation.documentEpoch, 3);
  assert.equal(observation.connector.authority, "untrusted_connector");
  assert.deepEqual(observation.connector.range, { startLine: 1, endLine: 100 });
  assert.equal(metrics.at(-1).source, "codex_mcp");
  assert.ok(metrics.at(-1).connectorObservationBytes < metrics.at(-1).domObservationBytes);
});

test("a navigation that bumps the epoch during the call discards the connector result", async () => {
  const browser = fakeBrowser();
  const { wrapped, metrics } = setup({ browser, readFile: async () => { browser.epoch = 4; return connectorResult({ text: "stale" }); } });
  const observation = await wrapped.observe();
  assert.equal(observation.text, DOM_TEXT);
  assert.equal(observation.connector, undefined);
  assert.equal(metrics.at(-1).code, "navigation_race");
});

test("a same-epoch URL change (history API) during the call discards the connector result", async () => {
  const browser = fakeBrowser();
  const { wrapped, metrics } = setup({ browser, readFile: async () => {
    browser.url = "https://github.com/deepseek-ai/deepseek-harness/blob/master/OTHER.md";
    return connectorResult({ text: "stale" });
  } });
  const observation = await wrapped.observe();
  assert.equal(observation.text, DOM_TEXT);
  assert.equal(metrics.at(-1).code, "navigation_race");
});

test("an observation that no longer matches the live page never starts a connector call", async () => {
  for (const state of [{ url: "https://github.com/other/page" }, { epoch: 9 }, { getBrowserSnapshot: undefined }, { getDocumentEpoch: undefined }]) {
    const { wrapped, calls } = setup({ browser: fakeBrowser(state) });
    const observation = await wrapped.observe();
    assert.equal(observation.text, DOM_TEXT);
    assert.equal(calls.length, 0, JSON.stringify(Object.keys(state)));
  }
});

test("dispose during an in-flight call aborts it and never leaks a late connector result", async () => {
  let release;
  let seenSignal;
  const { wrapped, browser } = setup({ readFile: (url, { signal }) => {
    seenSignal = signal;
    return new Promise((resolve) => { release = resolve; });
  } });
  const pending = wrapped.observe();
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  await wrapped.dispose();
  assert.equal(seenSignal.aborted, true);
  assert.equal(browser.disposed, true);
  release(connectorResult({ text: "LATE SECRET-FREE BUT STALE TEXT" }));
  await assert.rejects(pending, /observation_cancelled/);
  await assert.rejects(wrapped.observe(), /observation_cancelled/);
});

test("caller abort during an in-flight call rejects instead of returning connector text", async () => {
  let release;
  const { wrapped } = setup({ readFile: () => new Promise((resolve) => { release = resolve; }) });
  const controller = new AbortController();
  const pending = wrapped.observe({ signal: controller.signal });
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  release(connectorResult({ text: "late" }));
  await assert.rejects(pending, /observation_cancelled/);
});

test("a connector that never answers is bounded by a finite deadline and falls back to the DOM", async () => {
  let seenSignal;
  const { wrapped, metrics } = setup({ deadlineMs: 20, readFile: (url, { signal }) => { seenSignal = signal; return new Promise(() => {}); } });
  const started = Date.now();
  const observation = await wrapped.observe();
  assert.ok(Date.now() - started < 1000);
  assert.equal(observation.text, DOM_TEXT);
  assert.equal(seenSignal.aborted, true);
  assert.equal(metrics.at(-1).code, "deadline");
});

test("a busy shared broker, revoked login or tool error keeps the DOM observation", async () => {
  for (const code of ["busy", "app_unavailable", "tool_unavailable", "memory_pressure", "tool_error"]) {
    const { wrapped, metrics } = setup({ readFile: async () => { const e = new Error(code); e.code = code; throw e; } });
    const observation = await wrapped.observe();
    assert.equal(observation.text, DOM_TEXT);
    assert.equal(metrics.at(-1).source, "browser_fallback");
    assert.equal(metrics.at(-1).code, code);
  }
});

test("a connector observation that is not smaller than the DOM one is not selected", async () => {
  const { wrapped, metrics } = setup({ readFile: async () => connectorResult({ text: "x".repeat(DOM_TEXT.length * 2) }) });
  const observation = await wrapped.observe();
  assert.equal(observation.text, DOM_TEXT);
  assert.equal(observation.connector, undefined);
  const metric = metrics.at(-1);
  assert.equal(metric.source, "browser_fallback");
  assert.equal(metric.code, "not_smaller");
  assert.ok(metric.connectorObservationBytes >= metric.domObservationBytes);
  assert.equal(metrics.some((m) => m.source === "codex_mcp"), false);
});

test("filtered elements keep a consistent compact tree: dangling parents become null", async () => {
  const { wrapped } = setup();
  const observation = await wrapped.observe();
  const ids = new Set(observation.elements.map((e) => e.elementId));
  assert.deepEqual([...ids], ["0", "1", "2"]);
  for (const element of observation.elements) {
    assert.ok(element.parentElementId === null || ids.has(element.parentElementId), element.elementId);
  }
  assert.equal(observation.elements.find((e) => e.elementId === "1").parentElementId, "0");
  assert.equal(observation.elements.find((e) => e.elementId === "2").parentElementId, null);
});

test("execute enriches only the observation and preserves evidence, approval and action fields", async () => {
  const browser = fakeBrowser();
  const action = { type: "click", elementId: "0" };
  browser.executeResult = { status: "ok", action, observation: domObservation(),
    evidenceCandidate: { kind: "page_text", hash: "abc" }, approval: { id: "ap-1", decision: "approved" }, outcome: "navigated" };
  const { wrapped } = setup({ browser });
  const result = await wrapped.execute(action);
  assert.equal(result.observation.text, "# README\n");
  assert.deepEqual(result.evidenceCandidate, { kind: "page_text", hash: "abc" });
  assert.deepEqual(result.approval, { id: "ap-1", decision: "approved" });
  assert.equal(result.action, action);
  assert.equal(result.outcome, "navigated");
  assert.equal(result.status, "ok");
});

test("non-ok or observation-less execute results pass through without a connector call", async () => {
  for (const executeResult of [{ status: "denied", reason: "policy" }, { status: "ok" }]) {
    const browser = fakeBrowser({ executeResult });
    const { wrapped, calls } = setup({ browser });
    assert.equal(await wrapped.execute({ type: "click" }), executeResult);
    assert.equal(calls.length, 0);
  }
});

test("truncation and source range limits stay visible on the observation", async () => {
  const { wrapped } = setup({ readFile: async () => connectorResult({ text: "a", truncated: true, sourceBytes: 90000 }) });
  const observation = await wrapped.observe();
  assert.equal(observation.connector.truncated, true);
  assert.deepEqual(observation.connector.range, { startLine: 1, endLine: 100 });
});

test("connector inventory, schemas and unknown result fields never reach the model observation", async () => {
  const inventory = Array.from({ length: 396 }, (_, i) => ({ name: `tool_${i}`, inputSchema: { type: "object" } }));
  const { wrapped, metrics } = setup({ readFile: async () => connectorResult({ inventory, inputSchema: { secret: 1 }, rawResult: { content: [] } }) });
  const observation = await wrapped.observe();
  const serialized = JSON.stringify(observation) + JSON.stringify(metrics);
  for (const needle of ["tool_0", "tool_395", "inputSchema", "rawResult", "inventory"]) assert.equal(serialized.includes(needle), false, needle);
});

test("a throwing metric sink never changes the observation result", async () => {
  const browser = fakeBrowser();
  const wrapped = makeMcpBrowserObservation({ browser, connector: { readFile: async () => connectorResult() }, onMetric: () => { throw new Error("sink"); } });
  assert.equal((await wrapped.observe()).text, "# README\n");
});
