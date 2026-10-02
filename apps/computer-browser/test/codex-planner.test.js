"use strict";

// Codex CLI as a planner provider: a host-owned model allowlist, a worker
// that accepts only `--model <allowlisted id>`, and a bridge that runs
// `codex exec` with shell/web/plugins off in a read-only sandbox inside an
// empty temp directory, then validates the final message like Claude's.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");

const { CODEX_MODELS, CODEX_MODEL_IDS, DEFAULT_CODEX_MODEL, codexEffort } = require("../main/harness/providers/codex-models");
const { CodexPlannerBridge, CODEX_DISABLED_FEATURES } = require("../main/harness/providers/codex-planner-bridge");
const { parseCodexWorkerArgs, resolveCodexCommand, BUNDLED_CODEX_CLI } = require("../main/harness/providers/codex-planner-worker");
const { PLANNER_PROVIDERS, PLANNER_PROVIDER_IDS, selectPlannerLaunch } = require("../main/harness/planner-providers");
const { validateSettings } = require("../main/harness/host-settings");

const NODE = "/usr/local/bin/node";

test("the Codex model catalog is a frozen allowlist and effort never exceeds what a model supports", () => {
  assert.ok(Object.isFrozen(CODEX_MODELS));
  assert.deepEqual(CODEX_MODEL_IDS, ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5"]);
  // Names as the Codex app's model menu shows them; generations per the server catalog.
  assert.equal(DEFAULT_CODEX_MODEL, "gpt-6.1-sol");
  assert.deepEqual(CODEX_MODELS.map((m) => m.label), ["GPT-6.1 Sol", "GPT-6 Astra", "GPT-6 Sol", "GPT-6 Luna", "GPT-5.6 Sol", "GPT-5.6 Terra", "GPT-5.6 Luna", "GPT-5.5"]);
  assert.deepEqual(CODEX_MODELS.filter((m) => !m.legacy).map((m) => m.id), ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]);
  for (const m of CODEX_MODELS) { assert.ok(Object.isFrozen(m)); assert.equal(m.family, "gpt"); assert.equal(typeof m.description, "string"); }
  assert.equal(codexEffort("gpt-6-astra", "max"), "max");
  // ultra only where the server catalog offers it.
  assert.equal(codexEffort("gpt-6.1-sol", "ultra"), "ultra");
  assert.equal(codexEffort("gpt-5.6-terra", "ultra"), "ultra");
  assert.equal(codexEffort("gpt-6-luna", "ultra"), "max");
  assert.equal(codexEffort("gpt-5.6-luna", "ultra"), "max");
  assert.equal(codexEffort("gpt-5.5", "ultra"), "xhigh");
  assert.equal(codexEffort("gpt-5.5", "max"), "xhigh");
  assert.equal(codexEffort("gpt-5.5", "low"), "low");
});

test("codex_cli is an allowlisted planner provider that only takes Codex models", () => {
  assert.deepEqual(PLANNER_PROVIDER_IDS, ["none", "claude_code", "codex_cli"]);
  const worker = PLANNER_PROVIDERS.codex_cli.workerPath;
  assert.ok(fs.statSync(worker).isFile());
  assert.equal(PLANNER_PROVIDERS.codex_cli.usageProvider, "codex");
  assert.deepEqual(selectPlannerLaunch({ override: null, providerId: "codex_cli", model: "gpt-5.5", nodeCommand: NODE }),
    { source: "settings", command: NODE, args: [worker, "--model", "gpt-5.5"], usageProvider: "codex" });
  assert.equal(selectPlannerLaunch({ override: null, providerId: "codex_cli", model: "claude-opus-5-5", nodeCommand: NODE }).source, "invalid_model");
  assert.equal(selectPlannerLaunch({ override: null, providerId: "claude_code", model: "gpt-5.5", nodeCommand: NODE }).source, "invalid_model");
});

test("the Codex worker accepts no argv or exactly one allowlisted --model", () => {
  assert.deepEqual(parseCodexWorkerArgs([]), { model: DEFAULT_CODEX_MODEL });
  assert.deepEqual(parseCodexWorkerArgs(["--model", "gpt-5.6-luna"]), { model: "gpt-5.6-luna" });
  for (const argv of [["--model", "o3"], ["--model", "gpt-5.5", "-s", "danger-full-access"], ["--dangerously-bypass-approvals-and-sandbox"]]) {
    assert.throws(() => parseCodexWorkerArgs(argv), /model/, argv.join(" "));
  }
});

test("settings pair a Codex model only with the Codex provider", () => {
  const base = { version: 5, executionMode: "sequential", permissionMode: "browse", plannerEffort: "medium", plannerEffortMode: "auto", memoryPolicy: "budgeted", plannerProvider: "codex_cli", mcpProviders: [] };
  assert.deepEqual(validateSettings({ ...base, plannerModel: "gpt-5.6-sol" }), { ...base, plannerModel: "gpt-5.6-sol" });
  assert.throws(() => validateSettings({ ...base, plannerModel: "claude-opus-5-5" }), (e) => e.code === "invalid_planner_model");
  assert.throws(() => validateSettings({ ...base, plannerProvider: "claude_code", plannerModel: "gpt-5.5" }), (e) => e.code === "invalid_planner_model");
});

function fakeChild() {
  const child = new EventEmitter();
  child.stdin = { written: [], write: (data, enc, cb) => { child.stdin.written.push(data); if (cb) cb(); }, end() {} };
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.kill = () => { setImmediate(() => child.emit("close", null, "SIGTERM")); return true; };
  return child;
}

const CONTEXT = {
  taskId: "11111111-1111-4111-8111-111111111111",
  goalVersion: 1,
  goal: { originalRequest: "find the pricing page", amendments: [], constraints: [], criteria: [{ id: "C1", text: "pricing page found", kind: "host_check" }] },
  progress: { criteriaStatus: [], segment: { index: 0, callsInSegment: 0 }, budgets: {}, plannerEffort: "max" },
  recentEvents: [],
  observation: { id: "obs-1", url: "https://example.test/", elements: [] },
  untrustedSummary: null,
};
const PROPOSAL = { taskId: CONTEXT.taskId, goalVersion: 1, basedOnObservationId: "obs-1", criterionIds: ["C1"], kind: "actions", actions: [{ type: "observe" }] };

function run(bridge) {
  let captured;
  const child = fakeChild();
  bridge._spawnFn = (command, args, options) => { captured = { command, args, options }; return child; };
  const pending = bridge.start(CONTEXT);
  return { pending, child, get captured() { return captured; } };
}

test("the bridge runs codex exec locked down, with the prompt on stdin and only an env allowlist", async () => {
  const savedKey = process.env.HALO_APPROVER_KEY;
  process.env.HALO_APPROVER_KEY = "never-leak";
  const bridge = new CodexPlannerBridge({ model: "gpt-5.5" });
  try {
    const r = run(bridge);
    await new Promise((resolve) => setImmediate(resolve));
    const { command, args, options } = r.captured;
    assert.equal(command, "codex");
    assert.equal(options.shell, false);
    assert.equal("HALO_APPROVER_KEY" in options.env, false);
    assert.deepEqual(args.slice(0, 2), ["exec", "--json"]);
    for (const flag of ["--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "--ignore-rules"]) assert.ok(args.includes(flag), flag);
    assert.equal(args[args.indexOf("-s") + 1], "read-only");
    assert.equal(args[args.indexOf("-m") + 1], "gpt-5.5");
    assert.ok(args.includes('model_reasoning_effort="xhigh"'), "max is clamped for gpt-5.5");
    assert.ok(args.includes('approval_policy="never"') && args.includes('web_search="disabled"'));
    for (const feature of ["shell_tool", "unified_exec", "apps", "plugins", "browser_use", "computer_use", "multi_agent"]) {
      assert.ok(CODEX_DISABLED_FEATURES.includes(feature), feature);
      assert.equal(args[args.indexOf(feature) - 1], "--disable", feature);
    }
    assert.ok(!args.some((a) => /danger|bypass|workspace-write/.test(a)));
    assert.equal(args.at(-1), "-", "prompt comes from stdin, never argv");
    const workDir = args[args.indexOf("-C") + 1];
    assert.equal(options.cwd, workDir);
    assert.deepEqual(fs.readdirSync(workDir).filter((n) => n !== "schema.json"), []);
    assert.equal(fs.statSync(workDir).mode & 0o777, 0o700);
    assert.ok(r.child.stdin.written.join("").includes("find the pricing page"));

    r.child.stdout.emit("data", `${JSON.stringify({ type: "thread.started", thread_id: "t" })}\n`);
    r.child.stdout.emit("data", `${JSON.stringify({ type: "item.completed", item: { id: "i", type: "agent_message", text: JSON.stringify(PROPOSAL) } })}\n`);
    r.child.stdout.emit("data", `${JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 } })}\n`);
    r.child.emit("close", 0);
    assert.deepEqual(await r.pending, PROPOSAL);
    assert.deepEqual(bridge.takeUsage(), { provider: "codex", inputTokens: 10, outputTokens: 3, cacheReadTokens: 2, cacheCreationTokens: 0, costUsd: 0, durationMs: 0 });
  } finally {
    if (savedKey === undefined) delete process.env.HALO_APPROVER_KEY; else process.env.HALO_APPROVER_KEY = savedKey;
    await bridge.close();
  }
});

test("a Codex turn failure or a non-proposal message is never turned into a proposal", async () => {
  const bridge = new CodexPlannerBridge({ model: "gpt-5.6-luna" });
  try {
    let r = run(bridge);
    r.child.stdout.emit("data", `${JSON.stringify({ type: "turn.failed", error: { message: "model not available" } })}\n`);
    r.child.emit("close", 0);
    await assert.rejects(r.pending, (e) => e.code === "cli_error" && /not available/.test(e.message));
    r = run(bridge);
    r.child.stdout.emit("data", `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{\"kind\":\"rm -rf\"}" } })}\n`);
    r.child.emit("close", 0);
    await assert.rejects(r.pending, (e) => e.code === "invalid_proposal");
    r = run(bridge);
    r.child.emit("close", 1);
    await assert.rejects(r.pending, (e) => e.code === "cli_exit_nonzero");
  } finally {
    await bridge.close();
  }
  assert.throws(() => new CodexPlannerBridge({ model: "o3" }), /model/);
});

test("close() removes the bridge's temp work directory", async () => {
  const bridge = new CodexPlannerBridge({ model: "gpt-5.5" });
  const dir = bridge._workDir;
  assert.ok(fs.existsSync(dir));
  await bridge.close();
  assert.equal(fs.existsSync(dir), false);
});

test("the worker prefers an operator command, then the ChatGPT-bundled Codex CLI, then codex on PATH", () => {
  assert.equal(BUNDLED_CODEX_CLI, "/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex");
  assert.equal(resolveCodexCommand({ HALO_CODEX_CLI_COMMAND: "/opt/codex" }, () => true), "/opt/codex");
  assert.equal(resolveCodexCommand({}, (p) => p === BUNDLED_CODEX_CLI), BUNDLED_CODEX_CLI);
  assert.equal(resolveCodexCommand({}, () => false), "codex");
});
