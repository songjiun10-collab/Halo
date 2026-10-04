"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { escalationTarget } = require("../main/harness/planner-escalation");
const { tierOf } = require("../main/harness/model-tiers");
const { validateSettings, DEFAULT_SETTINGS } = require("../main/harness/host-settings");
const { TaskHost } = require("../main/harness/task-host");
const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");

test("escalationTarget moves one rung up, never down, never to a tried model", () => {
  const candidates = ["claude-opus-5-5", "claude-sonnet-5-5", "gpt-6-astra"];
  assert.equal(escalationTarget({ currentModel: "gpt-6-luna", candidates, tierOf }), "claude-sonnet-5-5");
  assert.equal(escalationTarget({ currentModel: "claude-sonnet-5-5", candidates, tierOf }), "claude-opus-5-5");
  assert.equal(escalationTarget({ currentModel: "claude-opus-5-5", candidates, tierOf }), null);
  assert.equal(escalationTarget({ currentModel: "claude-sonnet-5-5", candidates, tried: new Set(["claude-opus-5-5", "gpt-6-astra"]), tierOf }), null);
  assert.equal(escalationTarget({ currentModel: "claude-haiku-4-5", candidates: [], tierOf }), null);
});

test("plannerEscalation is an optional boolean setting, off unless set", () => {
  const base = { ...DEFAULT_SETTINGS };
  assert.equal("plannerEscalation" in validateSettings(base), false);
  assert.equal(validateSettings({ ...base, plannerEscalation: true }).plannerEscalation, true);
  assert.throws(() => validateSettings({ ...base, plannerEscalation: "yes" }), { code: "invalid_planner_escalation" });
});

async function newHost(extra = {}) {
  const made = [];
  const host = new TaskHost({
    storageRoot: await fs.mkdtemp(path.join(os.tmpdir(), "halo-escalate-host-")),
    makeBrowser: () => ({}),
    makePlanner: (id, pin) => { made.push(pin); return { next: async () => {}, close: async () => {} }; },
    hostVerifier: () => true,
    approve: async () => ({ decision: "allow", reasons: [] }),
    ...extra,
  });
  return { host, made };
}

test("the host escalates one tier up only when the setting is on, and remembers what it tried", async () => {
  const off = await newHost({ plannerProvider: "nvidia", plannerModel: "deepseek-ai/deepseek-v4-flash" });
  const on = await newHost({ plannerProvider: "nvidia", plannerModel: "deepseek-ai/deepseek-v4-flash", plannerEscalation: true });
  try {
    const pin = { plannerProvider: "nvidia", plannerModel: "deepseek-ai/deepseek-v4-flash" };
    assert.equal(off.host._escalatePlanner("t", pin, null, new Set(), () => {}), null);
    const tried = new Set(); let adopted = null;
    const first = on.host._escalatePlanner("t", pin, null, tried, (p) => { adopted = p; });
    assert.ok(first && first.planner === adopted);
    assert.equal(first.from, "deepseek-ai/deepseek-v4-flash");
    assert.ok(tierOf(first.to) < tierOf(first.from));
    assert.equal(on.made.at(-1).plannerModel, first.to);
    assert.equal(first.imageInput, on.made.at(-1).plannerProvider === "codex_cli");
    assert.ok(tried.has(first.to));
  } finally { await off.host.close(); await on.host.close(); }
});

function failingFixture(escalatePlanner) {
  return async (t) => {
    const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-escalate-ctl-"));
    const store = await TaskStore.create({ originalRequest: "go" }, { storageRoot });
    const closed = []; const calls = [];
    const weak = { next: async () => { calls.push("weak"); throw Object.assign(new Error("boom"), { code: "planner_failed" }); }, close: async () => { closed.push("weak"); } };
    const strong = { next: async (c) => { calls.push("strong"); return { taskId: c.taskId, goalVersion: c.goalVersion, basedOnObservationId: c.observation.id, criterionIds: [], kind: "finish", evidenceIds: [] }; }, close: async () => { closed.push("strong"); } };
    const controller = new TaskController({
      store, planner: weak, permissionMode: "browse", maxRecoveries: 2,
      approve: async () => ({ decision: "allow", reasons: [] }), hostVerifier: () => true,
      browser: { supportsAction: () => true, observe: async () => ({ id: "o", documentEpoch: 1, url: "https://p.test/", elements: [] }), execute: async () => ({ status: "ok" }) },
      ...(escalatePlanner ? { escalatePlanner: () => escalatePlanner(strong) } : {}),
    });
    t.after(async () => { await controller.stop().catch(() => {}); await store.close(); await fs.rm(storageRoot, { recursive: true, force: true }); });
    await controller.start();
    return { controller, calls, closed, store };
  };
}

test("when recovery is spent the controller swaps in the stronger planner once and continues", async (t) => {
  const { controller, calls, closed } = await failingFixture((strong) => ({ planner: strong, from: "weak", to: "strong" }))(t);
  assert.deepEqual(calls.slice(0, 3), ["weak", "weak", "weak"].slice(0, 3));
  assert.ok(calls.includes("strong"));
  assert.notEqual(controller.getSnapshot().pauseReason, "planner_error");
  assert.ok(closed.includes("weak"));
});

test("without an escalation hook the same failure still pauses as planner_error", async (t) => {
  const { controller, calls } = await failingFixture(null)(t);
  assert.equal(controller.getSnapshot().pauseReason, "planner_error");
  assert.ok(!calls.includes("strong"));
});

test("an escalation that finds nothing, or throws, leaves the ordinary pause", async (t) => {
  const a = await failingFixture(() => null)(t);
  assert.equal(a.controller.getSnapshot().pauseReason, "planner_error");
  const b = await failingFixture(() => { throw new Error("no key"); })(t);
  assert.equal(b.controller.getSnapshot().pauseReason, "planner_error");
});

const { routedModel, desiredTier } = require("../main/harness/planner-routing");

test("routing maps duration to a tier and stays within the supplied candidates", () => {
  assert.equal(desiredTier("fast"), 4);
  assert.equal(desiredTier("long"), 1);
  assert.equal(desiredTier("short"), null);
  const claude = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5-20251001", "claude-sonnet-4-20250514"];
  assert.equal(routedModel({ durationId: "short", currentModel: "claude-sonnet-5-5", candidates: claude, tierOf }), null);
  assert.equal(routedModel({ durationId: "fast", currentModel: "claude-opus-5-5", candidates: claude, tierOf }), "claude-sonnet-4-20250514");
  assert.equal(routedModel({ durationId: "long", currentModel: "claude-sonnet-5-5", candidates: claude, tierOf }), "claude-opus-5-5");
  assert.equal(routedModel({ durationId: "long", currentModel: "claude-opus-5-5", candidates: claude, tierOf }), null);
  assert.equal(routedModel({ durationId: "fast", currentModel: "x", candidates: [], tierOf }), null);
});

test("the host routes only when the setting is on and the task has a profile", async () => {
  const off = await newHost({ plannerProvider: "claude_code", plannerModel: "claude-opus-5-5" });
  const on = await newHost({ plannerProvider: "claude_code", plannerModel: "claude-opus-5-5", plannerRouting: true });
  try {
    const fast = { duration: { id: "fast" } };
    assert.equal(off.host._routedModel(fast), null);
    assert.equal(on.host._routedModel(null), null);
    assert.equal(on.host._routedModel({ duration: { id: "short" } }), null);
    const picked = on.host._routedModel(fast);
    assert.ok(picked && tierOf(picked) > tierOf("claude-opus-5-5"));
    assert.equal(on.host._plannerPin("parent", picked).plannerModel, picked);
  } finally { await off.host.close(); await on.host.close(); }
});

test("plannerRouting is an optional boolean setting", () => {
  const base = { ...DEFAULT_SETTINGS };
  assert.equal(validateSettings({ ...base, plannerRouting: true }).plannerRouting, true);
  assert.throws(() => validateSettings({ ...base, plannerRouting: 1 }), { code: "invalid_planner_routing" });
});
