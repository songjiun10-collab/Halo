"use strict";

// P2a (docs/superpowers/specs/2026-10-02-claude-dev-harness-efficiency-design.md
// section 6): a declarative workflow is data only. This module validates the
// plan (closed node types, bounded size, DAG, bound to one task/goalVersion)
// and replays host-recorded node starts/results into a deterministic state.
// It never runs anything: what is "ready" is a proposal for the existing
// TaskController path, and only host-recorded results move a node forward.

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateWorkflowPlan, WorkflowState, nodeIdempotencyKey, WorkflowError, MAX_WORKFLOW_NODES } = require("../main/harness/workflow-plan");

const TASK = "11111111-1111-4111-8111-111111111111";
const WF = "33333333-3333-4333-8333-333333333333";
const ROUTINE = "44444444-4444-4444-8444-444444444444";
const binding = { taskId: TASK, goalVersion: 2, criterionIds: ["c1", "c2"] };

function plan(nodes, overrides = {}) {
  return { version: 1, workflowId: WF, revision: 1, taskId: TASK, goalVersion: 2, nodes, ...overrides };
}

const collect = { id: "collect", type: "child", dependsOn: [], subgoal: "collect prices", entryUrl: "https://example.com/a" };
const compare = { id: "compare", type: "child", dependsOn: [], subgoal: "collect specs", entryUrl: "https://example.org/b" };
const join = { id: "join", type: "barrier", dependsOn: ["collect", "compare"], onFailure: "pause" };
const report = { id: "report", type: "synthesize", dependsOn: ["join"], criterionIds: ["c1"] };

const code = (fn) => { try { fn(); } catch (error) { assert.ok(error instanceof WorkflowError, String(error)); return error.code; } return null; };

test("a well-formed plan validates and comes back frozen, in a topological order", () => {
  const valid = validateWorkflowPlan(plan([report, join, collect, compare]), binding);
  assert.ok(Object.isFrozen(valid) && Object.isFrozen(valid.nodes[0]));
  const order = valid.order;
  assert.ok(order.indexOf("collect") < order.indexOf("join"));
  assert.ok(order.indexOf("join") < order.indexOf("report"));
  const routine = { id: "login", type: "routine", dependsOn: [], routineId: ROUTINE, revision: 3, digest: "a".repeat(64) };
  assert.ok(validateWorkflowPlan(plan([routine]), binding));
});

test("a plan is bound to its task and current goalVersion", () => {
  assert.equal(code(() => validateWorkflowPlan(plan([collect], { taskId: WF }), binding)), "binding_mismatch");
  assert.equal(code(() => validateWorkflowPlan(plan([collect], { goalVersion: 1 }), binding)), "binding_mismatch");
  assert.equal(code(() => validateWorkflowPlan(plan([collect], { version: 2 }), binding)), "invalid_field");
  assert.equal(code(() => validateWorkflowPlan(plan([collect], { revision: 0 }), binding)), "invalid_field");
});

test("cycles, self-edges, dangling and duplicate ids are rejected", () => {
  const a = { ...collect, id: "a", dependsOn: ["b"] };
  const b = { ...compare, id: "b", dependsOn: ["a"] };
  assert.equal(code(() => validateWorkflowPlan(plan([a, b]), binding)), "workflow_cycle");
  assert.equal(code(() => validateWorkflowPlan(plan([{ ...collect, dependsOn: ["collect"] }]), binding)), "workflow_cycle");
  assert.equal(code(() => validateWorkflowPlan(plan([{ ...collect, dependsOn: ["ghost"] }]), binding)), "unknown_dependency");
  assert.equal(code(() => validateWorkflowPlan(plan([collect, collect]), binding)), "duplicate_node");
  assert.equal(code(() => validateWorkflowPlan(plan([{ ...collect, dependsOn: [] }, { ...join, dependsOn: ["collect", "collect"] }]), binding)), "invalid_field");
});

test("the plan is data: unknown node types and fields, code-like fields, and oversize plans are rejected", () => {
  assert.equal(code(() => validateWorkflowPlan(plan([{ ...collect, type: "script" }]), binding)), "unknown_enum");
  assert.equal(code(() => validateWorkflowPlan(plan([{ ...collect, run: "rm -rf /" }]), binding)), "unknown_field");
  assert.equal(code(() => validateWorkflowPlan(plan([collect], { onComplete: "() => 1" }), binding)), "unknown_field");
  assert.equal(code(() => validateWorkflowPlan(plan([]), binding)), "invalid_field");
  const many = Array.from({ length: MAX_WORKFLOW_NODES + 1 }, (_, i) => ({ ...collect, id: `n${i}` }));
  assert.equal(MAX_WORKFLOW_NODES, 32);
  assert.equal(code(() => validateWorkflowPlan(plan(many), binding)), "field_too_large");
  assert.equal(code(() => validateWorkflowPlan(plan([{ ...collect, id: "Bad Id" }]), binding)), "invalid_field");
});

test("node payloads reuse the existing contracts", () => {
  assert.equal(code(() => validateWorkflowPlan(plan([{ ...collect, entryUrl: "file:///etc/passwd" }]), binding)), "invalid_field");
  assert.equal(code(() => validateWorkflowPlan(plan([{ ...collect, entryUrl: "https://u:p@example.com/" }]), binding)), "invalid_field");
  assert.equal(code(() => validateWorkflowPlan(plan([{ id: "r", type: "routine", dependsOn: [], routineId: ROUTINE, revision: 1, digest: "xyz" }]), binding)), "invalid_field");
  assert.equal(code(() => validateWorkflowPlan(plan([{ ...join, dependsOn: [] }]), binding)), "invalid_field", "a barrier joins something");
  assert.equal(code(() => validateWorkflowPlan(plan([collect, { ...join, dependsOn: ["collect"], onFailure: "continue" }]), binding)), "unknown_enum", "partial results need a later, explicit contract");
  assert.equal(code(() => validateWorkflowPlan(plan([collect, { ...report, dependsOn: ["collect"], criterionIds: ["c9"] }]), binding)), "unknown_criterion");
  assert.equal(code(() => validateWorkflowPlan(plan([{ ...report, dependsOn: [] }]), binding)), "invalid_field", "synthesis needs inputs");
});

test("idempotency keys bind workflow, revision, node and attempt", () => {
  const key = nodeIdempotencyKey({ workflowId: WF, revision: 1, nodeId: "collect", attempt: 1 });
  assert.equal(key, `wf:${WF}:r1:collect:a1`);
  assert.notEqual(key, nodeIdempotencyKey({ workflowId: WF, revision: 2, nodeId: "collect", attempt: 1 }));
  assert.notEqual(key, nodeIdempotencyKey({ workflowId: WF, revision: 1, nodeId: "collect", attempt: 2 }));
});

function state(nodes = [report, join, collect, compare]) {
  return new WorkflowState(validateWorkflowPlan(plan(nodes), binding));
}

test("only nodes whose dependencies succeeded are ready; barriers resolve themselves", () => {
  const s = state();
  assert.deepEqual(s.ready(), ["collect", "compare"]);
  s.recordStarted({ nodeId: "collect", attempt: 1 });
  assert.deepEqual(s.ready(), ["compare"]);
  s.recordResult({ nodeId: "collect", attempt: 1, outcome: "succeeded" });
  s.recordStarted({ nodeId: "compare", attempt: 1 });
  assert.equal(s.status().state, "running");
  s.recordResult({ nodeId: "compare", attempt: 1, outcome: "succeeded" });
  assert.equal(s.node("join").status, "succeeded", "a barrier is passed by the host, never started");
  assert.deepEqual(s.ready(), ["report"]);
  s.recordStarted({ nodeId: "report", attempt: 1 });
  s.recordResult({ nodeId: "report", attempt: 1, outcome: "succeeded" });
  assert.deepEqual(s.status(), { state: "completed" });
});

test("a failed, cancelled or uncertain dependency is never synthesized as success: the barrier pauses", () => {
  for (const outcome of ["failed", "cancelled", "uncertain"]) {
    const s = state();
    for (const id of ["collect", "compare"]) s.recordStarted({ nodeId: id, attempt: 1 });
    s.recordResult({ nodeId: "collect", attempt: 1, outcome: "succeeded" });
    s.recordResult({ nodeId: "compare", attempt: 1, outcome });
    assert.equal(s.node("join").status, "blocked", outcome);
    assert.deepEqual(s.ready(), [], outcome);
    assert.deepEqual(s.status(), { state: "paused", reason: "workflow_dependency_failed", nodeId: "join" }, outcome);
  }
});

test("results are accepted only for a started node, once, for its attempt", () => {
  const s = state();
  assert.equal(code(() => s.recordResult({ nodeId: "collect", attempt: 1, outcome: "succeeded" })), "node_not_started");
  assert.equal(code(() => s.recordStarted({ nodeId: "report", attempt: 1 })), "node_not_ready");
  assert.equal(code(() => s.recordStarted({ nodeId: "join", attempt: 1 })), "node_not_ready", "barriers are not started");
  s.recordStarted({ nodeId: "collect", attempt: 1 });
  assert.equal(code(() => s.recordStarted({ nodeId: "collect", attempt: 2 })), "node_not_ready");
  assert.equal(code(() => s.recordResult({ nodeId: "collect", attempt: 2, outcome: "succeeded" })), "attempt_mismatch");
  assert.equal(code(() => s.recordResult({ nodeId: "collect", attempt: 1, outcome: "done" })), "unknown_enum");
  s.recordResult({ nodeId: "collect", attempt: 1, outcome: "succeeded" });
  assert.equal(code(() => s.recordResult({ nodeId: "collect", attempt: 1, outcome: "failed" })), "node_not_started", "a result is final");
});

test("recovery turns started-without-result into uncertain and never re-runs it", () => {
  const records = [
    { type: "workflow_node_started", nodeId: "collect", attempt: 1 },
    { type: "workflow_node_result", nodeId: "collect", attempt: 1, outcome: "succeeded" },
    { type: "workflow_node_started", nodeId: "compare", attempt: 1 },
  ];
  const s = WorkflowState.replay(validateWorkflowPlan(plan([report, join, collect, compare]), binding), records);
  assert.equal(s.node("compare").status, "uncertain");
  assert.deepEqual(s.ready(), []);
  assert.deepEqual(s.status(), { state: "paused", reason: "workflow_dependency_failed", nodeId: "join" });
  assert.equal(code(() => WorkflowState.replay(validateWorkflowPlan(plan([collect]), binding), [{ type: "workflow_node_result", nodeId: "collect", attempt: 1, outcome: "succeeded" }])), "node_not_started",
    "a journal that does not replay cleanly fails closed");
});

test("a node that cannot be reached is reported, not silently skipped", () => {
  const after = { ...compare, id: "after", dependsOn: ["collect"] };
  const s = state([collect, after]);
  s.recordStarted({ nodeId: "collect", attempt: 1 });
  s.recordResult({ nodeId: "collect", attempt: 1, outcome: "failed" });
  assert.deepEqual(s.ready(), []);
  assert.deepEqual(s.status(), { state: "paused", reason: "workflow_dependency_failed", nodeId: "after" });
});

test("snapshot exposes per-node status without bodies", () => {
  const s = state([collect]);
  assert.deepEqual(s.snapshot(), { workflowId: WF, revision: 1, status: { state: "running" }, nodes: [{ id: "collect", type: "child", status: "pending", attempt: 0 }] });
});
