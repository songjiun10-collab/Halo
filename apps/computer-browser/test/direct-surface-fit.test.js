"use strict";

// The React shell has no fixed side panel: the user's own browser view must
// fill the page slot the renderer measures (as task surfaces already do),
// clamped only to the window and kept below the tab strip + toolbar.

const test = require("node:test");
const assert = require("node:assert/strict");
const { ControlApi } = require("../main/control-api");
const { MIN_CHROME_HEIGHT } = require("../main/harness/browser-surfaces");

function makeApi(width, height) {
  const applied = [];
  const api = new ControlApi({ window: { getContentSize: () => [width, height] }, socketPath: "/tmp/fake.sock", requestDecision: async () => ({}), minAgentActionIntervalMs: 0 });
  api._view = { setBounds: (b) => applied.push(b) };
  return { api, applied };
}

test("the direct browser view fills the measured page slot to the right edge", () => {
  const { api, applied } = makeApi(1280, 800);
  api.setBrowserBounds({ x: 80, y: 146, width: 1164, height: 634, visible: true });
  assert.deepEqual(applied.at(-1), { x: 80, y: 146, width: 1164, height: 634 });
});

test("the direct browser view is still clamped to the window and below the chrome", () => {
  const { api, applied } = makeApi(1280, 800);
  api.setBrowserBounds({ x: -20, y: 10, width: 5000, height: 5000, visible: true });
  assert.deepEqual(applied.at(-1), { x: 0, y: MIN_CHROME_HEIGHT, width: 1280, height: 800 - MIN_CHROME_HEIGHT });
  api.setBrowserBounds({ x: 0, y: 94, width: 0, height: 0, visible: false });
  assert.deepEqual(applied.at(-1), { x: 0, y: 94, width: 0, height: 0 });
});
