"use strict";

// Planner model selection: a host-owned Claude model allowlist flows
// settings -> TaskHost pin -> selectPlannerLaunch argv -> worker argv ->
// ClaudeCodeBridge `--model`. No caller can supply a free-form model string.

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");

const { CLAUDE_MODELS, CLAUDE_MODEL_IDS, DEFAULT_CLAUDE_MODEL } = require("../main/harness/providers/claude-models");
const { PLANNER_PROVIDERS, selectPlannerLaunch } = require("../main/harness/planner-providers");
const { ClaudeCodeBridge, CLI_ARGS } = require("../main/harness/providers/claude-code-bridge");
const { parseWorkerArgs } = require("../main/harness/providers/claude-code-worker");
const { HostSettingsStore, validateSettings } = require("../main/harness/host-settings");

const NODE = "/usr/local/bin/node";

test("the model catalog is a frozen allowlist with versioned Opus, Sonnet and Haiku plus legacy entries", () => {
  assert.ok(Object.isFrozen(CLAUDE_MODELS));
  assert.ok(Object.isFrozen(CLAUDE_MODEL_IDS));
  assert.equal(DEFAULT_CLAUDE_MODEL, "claude-opus-5-5");
  assert.deepEqual(CLAUDE_MODEL_IDS, CLAUDE_MODELS.map((m) => m.id));
  assert.equal(new Set(CLAUDE_MODEL_IDS).size, CLAUDE_MODEL_IDS.length);
  for (const model of CLAUDE_MODELS) {
    assert.ok(Object.isFrozen(model));
    assert.match(model.id, /^claude-[a-z0-9-]+$/);
    assert.match(model.label, /^(Opus|Sonnet|Haiku|Fable) \d+(\.\d+)?$/);
    assert.equal(typeof model.legacy, "boolean");
  }
  const current = CLAUDE_MODELS.filter((m) => !m.legacy).map((m) => m.label);
  assert.ok(current.includes("Opus 5.5") && current.includes("Sonnet 5.5") && current.includes("Haiku 4.5"));
  const legacy = CLAUDE_MODELS.filter((m) => m.legacy).map((m) => m.family);
  for (const family of ["opus", "sonnet", "haiku"]) assert.ok(legacy.includes(family), family);
});

test("selectPlannerLaunch appends only an allowlisted model to the worker argv", () => {
  const worker = PLANNER_PROVIDERS.claude_code.workerPath;
  assert.deepEqual(selectPlannerLaunch({ override: null, providerId: "claude_code", model: "claude-sonnet-5-5", nodeCommand: NODE }),
    { source: "settings", command: NODE, args: [worker, "--model", "claude-sonnet-5-5"], usageProvider: "claude" });
  for (const model of ["opus", "--tools", "claude-opus-5-5 --x", "toString", 1, null]) {
    assert.deepEqual(selectPlannerLaunch({ override: null, providerId: "claude_code", model, nodeCommand: NODE }),
      { source: "invalid_model", command: null, args: [], usageProvider: null }, String(model));
  }
  // An operator override keeps its own argv untouched.
  assert.deepEqual(selectPlannerLaunch({ override: { configured: true, command: NODE, args: ["x.js"] }, providerId: "claude_code", model: "claude-sonnet-5-5", nodeCommand: NODE }).args, ["x.js"]);
});

test("the worker accepts no argv or exactly one allowlisted --model", () => {
  assert.deepEqual(parseWorkerArgs([]), { model: undefined });
  assert.deepEqual(parseWorkerArgs(["--model", "claude-haiku-4-5-20251001"]), { model: "claude-haiku-4-5-20251001" });
  for (const argv of [["--model"], ["--model", "opus"], ["--model", "claude-opus-5-5", "--tools", "x"], ["--effort", "max"], ["claude-opus-5-5"]]) {
    assert.throws(() => parseWorkerArgs(argv), /model/, argv.join(" "));
  }
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = { write: (data, enc, cb) => { if (cb) cb(); }, end() {}, on() {} };
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.killed = false;
  child.kill = () => { child.killed = true; setImmediate(() => child.emit("close", null, "SIGTERM")); return true; };
  return child;
}

const CONTEXT = {
  taskId: "11111111-1111-4111-8111-111111111111",
  goalVersion: 1,
  goal: { originalRequest: "find the pricing page", amendments: [], constraints: [], criteria: [{ id: "C1", text: "pricing page found", kind: "host_check" }] },
  progress: { criteriaStatus: [], segment: { index: 0, callsInSegment: 0 }, budgets: {} },
  recentEvents: [],
  observation: { id: "obs-1", url: "https://example.test/", elements: [] },
  untrustedSummary: null,
};

test("the bridge spawns claude with the chosen model in place of the opus alias, and rejects unknown models", async () => {
  let args;
  const bridge = new ClaudeCodeBridge({ model: "claude-sonnet-4-5-20250929", spawnFn: (command, a) => { args = a; return fakeChild(); } });
  bridge.start(CONTEXT).catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  const expected = [...CLI_ARGS];
  expected[CLI_ARGS.indexOf("--model") + 1] = "claude-sonnet-4-5-20250929";
  assert.deepEqual(args, [...expected, "--effort", "medium"]);
  assert.equal(args.filter((a) => a === "--model").length, 1);
  await bridge.close();
  assert.throws(() => new ClaudeCodeBridge({ model: "opus; rm -rf" }), /model/);
});

test("plannerModel is an optional allowlisted setting that keeps the v5 shape when unset", async () => {
  const base = { version: 5, executionMode: "sequential", permissionMode: "browse", plannerEffort: "medium", plannerEffortMode: "auto", memoryPolicy: "budgeted", plannerProvider: "claude_code", mcpProviders: [] };
  assert.deepEqual(validateSettings(base), base);
  assert.deepEqual(validateSettings({ ...base, plannerModel: "claude-opus-4-1-20250805" }), { ...base, plannerModel: "claude-opus-4-1-20250805" });
  for (const plannerModel of ["opus", "", null, "claude-gpt"]) {
    assert.throws(() => validateSettings({ ...base, plannerModel }), (error) => error.code === "invalid_planner_model", String(plannerModel));
  }
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-models-"));
  const store = new HostSettingsStore({ storageRoot });
  const saved = await store.update({ plannerModel: "claude-haiku-4-5-20251001" }, { actor: "user" });
  assert.equal(saved.plannerModel, "claude-haiku-4-5-20251001");
  assert.equal((await store.load()).plannerModel, "claude-haiku-4-5-20251001");
  await assert.rejects(store.update({ plannerModel: "--tools" }, { actor: "user" }), (error) => error.code === "invalid_planner_model");
});

test("ultra is a host effort level; Claude has no ultra, so the bridge runs it as max", async () => {
  const { PLANNER_EFFORTS } = require("../main/harness/host-settings");
  const { effortForRoute } = require("../main/harness/planner-effort-policy");
  assert.deepEqual(PLANNER_EFFORTS, ["low", "medium", "high", "xhigh", "max", "ultra"]);
  assert.equal(effortForRoute({ base: "ultra", mode: "fixed", route: "long" }), "ultra");
  assert.equal(effortForRoute({ base: "ultra", mode: "auto", route: "short" }), "low");
  let args;
  const bridge = new ClaudeCodeBridge({ spawnFn: (command, a) => { args = a; return fakeChild(); } });
  bridge.start({ ...CONTEXT, progress: { ...CONTEXT.progress, plannerEffort: "ultra" } }).catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(args.slice(-2), ["--effort", "max"]);
  await bridge.close();
});
