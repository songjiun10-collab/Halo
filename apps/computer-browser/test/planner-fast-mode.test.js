"use strict";

// Fast mode: an opt-in host setting (off by default) that asks the planner
// CLI for its faster service tier. Codex takes `service_tier="priority"` on
// every allowlisted model; Claude takes `fastMode` on Opus only (it spends
// account credits). The flag rides the same host-owned path as --model:
// settings -> planner pin -> worker argv (strictly parsed) -> fixed CLI args.

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs/promises");
const { test } = require("node:test");

const { validateSettings, HostSettingsStore } = require("../main/harness/host-settings");
const { selectPlannerLaunch, PLANNER_PROVIDERS } = require("../main/harness/planner-providers");
const { parseWorkerArgs } = require("../main/harness/providers/claude-code-worker");
const { parseCodexWorkerArgs } = require("../main/harness/providers/codex-planner-worker");
const { ClaudeCodeBridge } = require("../main/harness/providers/claude-code-bridge");
const { CodexPlannerBridge } = require("../main/harness/providers/codex-planner-bridge");
const { DEFAULT_CODEX_MODEL } = require("../main/harness/providers/codex-models");
const { TaskHost } = require("../main/harness/task-host");

const NODE = "/usr/local/bin/node";
const BASE = { version: 5, executionMode: "sequential", permissionMode: "browse", plannerEffort: "medium", plannerEffortMode: "auto", memoryPolicy: "budgeted", plannerProvider: "claude_code", mcpProviders: [] };

test("plannerFast is an optional boolean setting, off unless set", async () => {
  assert.deepEqual(validateSettings({ ...BASE, plannerFast: true }), { ...BASE, plannerFast: true });
  assert.equal("plannerFast" in validateSettings(BASE), false);
  for (const bad of ["true", 1, null]) {
    assert.throws(() => validateSettings({ ...BASE, plannerFast: bad }), (e) => e.code === "invalid_planner_fast");
  }
  const store = new HostSettingsStore({ storageRoot: await fs.mkdtemp(path.join(os.tmpdir(), "halo-fast-")) });
  assert.equal((await store.load()).plannerFast, undefined);
  assert.equal((await store.update({ plannerFast: true })).plannerFast, true);
  assert.equal((await store.load()).plannerFast, true);
  assert.equal((await store.update({ plannerFast: false })).plannerFast, false);
});

test("the launch passes --fast only when the pin asks for it, never for an operator override", () => {
  const worker = PLANNER_PROVIDERS.codex_cli.workerPath;
  assert.deepEqual(selectPlannerLaunch({ override: null, providerId: "codex_cli", model: "gpt-5.5", fast: true, nodeCommand: NODE }).args, [worker, "--model", "gpt-5.5", "--fast"]);
  assert.deepEqual(selectPlannerLaunch({ override: null, providerId: "claude_code", fast: true, nodeCommand: NODE }).args, [PLANNER_PROVIDERS.claude_code.workerPath, "--fast"]);
  assert.deepEqual(selectPlannerLaunch({ override: null, providerId: "codex_cli", model: "gpt-5.5", fast: false, nodeCommand: NODE }).args, [worker, "--model", "gpt-5.5"]);
  const override = { configured: true, command: "/bin/x", args: ["a"] };
  assert.deepEqual(selectPlannerLaunch({ override, providerId: "codex_cli", fast: true, nodeCommand: NODE }).args, ["a"]);
});

test("workers accept --fast once, after an optional --model, and nothing else", () => {
  assert.deepEqual(parseWorkerArgs(["--fast"]), { model: undefined, fast: true });
  assert.deepEqual(parseWorkerArgs(["--model", "claude-opus-5-5", "--fast"]), { model: "claude-opus-5-5", fast: true });
  assert.deepEqual(parseWorkerArgs(["--model", "claude-opus-5-5"]), { model: "claude-opus-5-5", fast: false });
  assert.deepEqual(parseCodexWorkerArgs(["--fast"]), { model: DEFAULT_CODEX_MODEL, fast: true });
  assert.deepEqual(parseCodexWorkerArgs(["--model", "gpt-5.5", "--fast"]), { model: "gpt-5.5", fast: true });
  for (const argv of [["--fast", "--fast"], ["--fast", "--model", "gpt-5.5"], ["--fast", "x"], ["--fast=1"]]) {
    assert.throws(() => parseWorkerArgs(argv), /model/, argv.join(" "));
    assert.throws(() => parseCodexWorkerArgs(argv), /model/, argv.join(" "));
  }
});

const FAST_SETTINGS = ["--settings", JSON.stringify({ fastMode: true })];
const hasPair = (args, [a, b]) => args.some((arg, i) => arg === a && args[i + 1] === b);

test("Claude asks for fast mode only on an Opus model", () => {
  assert.ok(hasPair(new ClaudeCodeBridge({ fast: true })._argsFor("medium"), FAST_SETTINGS), "unpinned runs the opus alias");
  assert.ok(hasPair(new ClaudeCodeBridge({ fast: true, model: "claude-opus-5-5" })._argsFor("medium"), FAST_SETTINGS));
  assert.equal(new ClaudeCodeBridge({ fast: true, model: "claude-sonnet-5-5" })._argsFor("medium").includes("--settings"), false);
  assert.equal(new ClaudeCodeBridge({ model: "claude-opus-5-5" })._argsFor("medium").includes("--settings"), false);
});

test("Codex asks for the priority service tier when fast", () => {
  const fast = new CodexPlannerBridge({ model: "gpt-6.1-sol", fast: true });
  const normal = new CodexPlannerBridge({ model: "gpt-6.1-sol" });
  try {
    assert.ok(hasPair(fast._argsFor("medium"), ["-c", 'service_tier="priority"']));
    assert.equal(normal._argsFor("medium").some((arg) => arg.startsWith("service_tier")), false);
  } finally {
    void fast.close?.();
    void normal.close?.();
  }
});

test("the planner pin carries plannerFast to new planners", async () => {
  const host = new TaskHost({
    storageRoot: await fs.mkdtemp(path.join(os.tmpdir(), "halo-fast-host-")),
    makeBrowser: () => ({}),
    makePlanner: () => ({}),
    hostVerifier: () => true,
    approve: async () => ({ decision: "allow", reasons: [] }),
    plannerProvider: "codex_cli",
    plannerFast: true,
  });
  try {
    assert.equal(host._plannerPin("parent").plannerFast, true);
    assert.equal(host._plannerPin("parent", "gpt-5.5").plannerFast, true);
  } finally {
    await host.close();
  }
});
