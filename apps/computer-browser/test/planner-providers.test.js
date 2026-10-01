"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const {
  PLANNER_PROVIDER_IDS,
  PLANNER_PROVIDERS,
  parseOperatorOverride,
  selectPlannerLaunch,
} = require("../main/harness/planner-providers");

const NODE = "/usr/local/bin/node";

test("provider registry is a frozen host allowlist whose workers live inside the app", () => {
  assert.deepEqual(PLANNER_PROVIDER_IDS, ["none", "claude_code"]);
  assert.ok(Object.isFrozen(PLANNER_PROVIDER_IDS));
  assert.ok(Object.isFrozen(PLANNER_PROVIDERS));
  assert.equal(Object.getPrototypeOf(PLANNER_PROVIDERS), null);
  assert.deepEqual(Object.keys(PLANNER_PROVIDERS), ["claude_code"]);
  const entry = PLANNER_PROVIDERS.claude_code;
  assert.ok(Object.isFrozen(entry));
  assert.equal(entry.usageProvider, "claude");
  assert.equal(entry.workerPath, path.resolve(__dirname, "../main/harness/providers/claude-code-worker.js"));
  assert.ok(fs.statSync(entry.workerPath).isFile());
});

test("operator override is absent, configured or invalid exactly as before", () => {
  assert.equal(parseOperatorOverride({}, NODE), null);
  assert.equal(parseOperatorOverride({ HALO_PLANNER_ARGS: "" }, NODE), null);
  assert.deepEqual(parseOperatorOverride({ HALO_PLANNER_COMMAND: "/opt/worker", HALO_PLANNER_ARGS: "" }, "/opt/worker"),
    { configured: true, command: "/opt/worker", args: [] });
  assert.deepEqual(parseOperatorOverride({ HALO_PLANNER_COMMAND: "/opt/worker" }, "/opt/worker"),
    { configured: true, command: "/opt/worker", args: [] });
  assert.deepEqual(parseOperatorOverride({ HALO_PLANNER_ARGS: '["worker.js","--x"]' }, NODE),
    { configured: true, command: NODE, args: ["worker.js", "--x"] });
  for (const args of ["[]", "not json", '[1]', '"worker.js"']) {
    assert.deepEqual(parseOperatorOverride({ HALO_PLANNER_COMMAND: "/opt/worker", HALO_PLANNER_ARGS: args }, "/opt/worker"),
      { configured: false, command: null, args: [] }, args);
  }
});

test("operator override wins over settings and an invalid override never falls back to settings", () => {
  const override = parseOperatorOverride({ HALO_PLANNER_ARGS: '["custom.js"]' }, NODE);
  assert.deepEqual(selectPlannerLaunch({ override, providerId: "claude_code", nodeCommand: NODE }),
    { source: "operator", command: NODE, args: ["custom.js"], usageProvider: null });
  const invalid = parseOperatorOverride({ HALO_PLANNER_ARGS: "[]" }, NODE);
  assert.deepEqual(selectPlannerLaunch({ override: invalid, providerId: "claude_code", nodeCommand: NODE }),
    { source: "operator_invalid", command: null, args: [], usageProvider: null });
});

test("settings select only allowlisted workers and none keeps the planner unavailable", () => {
  assert.deepEqual(selectPlannerLaunch({ override: null, providerId: "claude_code", nodeCommand: NODE }),
    { source: "settings", command: NODE, args: [PLANNER_PROVIDERS.claude_code.workerPath], usageProvider: "claude" });
  assert.deepEqual(selectPlannerLaunch({ override: null, providerId: "none", nodeCommand: NODE }),
    { source: "none", command: null, args: [], usageProvider: null });
  assert.deepEqual(selectPlannerLaunch({ override: null, providerId: undefined, nodeCommand: NODE }),
    { source: "none", command: null, args: [], usageProvider: null });
  for (const providerId of ["toString", "__proto__", "codex", "/bin/sh", 1]) {
    assert.deepEqual(selectPlannerLaunch({ override: null, providerId, nodeCommand: NODE }),
      { source: "invalid_provider", command: null, args: [], usageProvider: null }, String(providerId));
  }
});
