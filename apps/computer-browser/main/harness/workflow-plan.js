"use strict";

// P2a declarative workflow (docs/superpowers/specs/2026-10-02-claude-dev-harness-efficiency-design.md
// section 6). Pure: no fs, no IPC, no timers, nothing executed. A plan is data
// with four closed node types (child, routine, barrier, synthesize), at most
// 32 nodes, acyclic, and bound to one task and its current goalVersion.
// WorkflowState replays host-recorded node starts/results; ready() only says
// what may be proposed next through the existing TaskController path
// (policy -> approver -> executor). It has no dispatch of its own.
//
// v1 deliberately has no partial-result policy and no loops: a barrier whose
// inputs did not all succeed pauses the workflow, and iteration needs its own
// budget contract first.

const contracts = require("../../shared/harness-contracts");

const MAX_WORKFLOW_NODES = 32;
const NODE_TYPES = Object.freeze(["child", "routine", "barrier", "synthesize"]);
const OUTCOMES = Object.freeze(["succeeded", "failed", "cancelled", "uncertain"]);
const NODE_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;
const PLAN_FIELDS = ["version", "workflowId", "revision", "taskId", "goalVersion", "nodes"];
const NODE_FIELDS = {
  child: ["id", "type", "dependsOn", "subgoal", "entryUrl"],
  routine: ["id", "type", "dependsOn", "routineId", "revision", "digest"],
  barrier: ["id", "type", "dependsOn", "onFailure"],
  synthesize: ["id", "type", "dependsOn", "criterionIds"],
};

class WorkflowError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "WorkflowError";
    this.code = code;
  }
}

const fail = (code, message) => { throw new WorkflowError(code, message); };
const positiveInt = (v) => Number.isInteger(v) && v > 0;

function onlyKnownKeys(value, allowed, label) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail("unknown_field", `${label} has unknown field "${key}"`);
}

function validateNode(node, index, binding) {
  const label = `nodes[${index}]`;
  if (!contracts.isPlainObject(node)) fail("invalid_field", `${label} must be an object`);
  if (!NODE_TYPES.includes(node.type)) fail("unknown_enum", `${label}.type must be one of ${NODE_TYPES.join("|")}`);
  onlyKnownKeys(node, NODE_FIELDS[node.type], label);
  if (typeof node.id !== "string" || !NODE_ID_RE.test(node.id)) fail("invalid_field", `${label}.id must match ${NODE_ID_RE}`);
  if (!Array.isArray(node.dependsOn) || node.dependsOn.some((d) => typeof d !== "string") || new Set(node.dependsOn).size !== node.dependsOn.length) {
    fail("invalid_field", `${label}.dependsOn must be an array of distinct node ids`);
  }
  if (node.type === "child") {
    try {
      contracts.validateChildAssignment({ subgoal: node.subgoal, entryUrl: node.entryUrl }, label);
    } catch (error) {
      fail(typeof error?.code === "string" ? error.code : "invalid_field", error.message);
    }
  } else if (node.type === "routine") {
    if (typeof node.routineId !== "string" || !contracts.UUID_RE.test(node.routineId)) fail("invalid_field", `${label}.routineId must be a UUID`);
    if (!positiveInt(node.revision)) fail("invalid_field", `${label}.revision must be a positive integer`);
    if (typeof node.digest !== "string" || !DIGEST_RE.test(node.digest)) fail("invalid_field", `${label}.digest must be a sha256 hex digest`);
  } else if (node.type === "barrier") {
    if (node.dependsOn.length === 0) fail("invalid_field", `${label} barrier must depend on at least one node`);
    if (node.onFailure !== "pause") fail("unknown_enum", `${label}.onFailure must be "pause" in workflow v1`);
  } else {
    if (node.dependsOn.length === 0) fail("invalid_field", `${label} synthesize must depend on at least one node`);
    if (!Array.isArray(node.criterionIds) || node.criterionIds.length === 0 || node.criterionIds.some((c) => typeof c !== "string")) {
      fail("invalid_field", `${label}.criterionIds must be a non-empty array of criterion ids`);
    }
    for (const id of node.criterionIds) if (!binding.criterionIds.includes(id)) fail("unknown_criterion", `${label} names criterion ${id} that the goal does not have`);
  }
}

// Kahn's algorithm; ties keep the plan's own order so the result is stable.
function topologicalOrder(nodes) {
  const indegree = new Map(nodes.map((n) => [n.id, n.dependsOn.length]));
  const order = [];
  const done = new Set();
  while (order.length < nodes.length) {
    const next = nodes.find((n) => !done.has(n.id) && indegree.get(n.id) === 0);
    if (!next) fail("workflow_cycle", "workflow nodes must form a DAG");
    done.add(next.id);
    order.push(next.id);
    for (const n of nodes) if (n.dependsOn.includes(next.id)) indegree.set(n.id, indegree.get(n.id) - 1);
  }
  return order;
}

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

// binding: { taskId, goalVersion, criterionIds } from the host's current goal.
function validateWorkflowPlan(plan, binding) {
  if (!contracts.isPlainObject(plan)) fail("invalid_field", "workflow plan must be an object");
  onlyKnownKeys(plan, PLAN_FIELDS, "workflow");
  if (plan.version !== 1) fail("invalid_field", "workflow.version must be 1");
  if (typeof plan.workflowId !== "string" || !contracts.UUID_RE.test(plan.workflowId)) fail("invalid_field", "workflow.workflowId must be a UUID");
  if (!positiveInt(plan.revision)) fail("invalid_field", "workflow.revision must be a positive integer");
  if (plan.taskId !== binding.taskId || plan.goalVersion !== binding.goalVersion) {
    fail("binding_mismatch", "workflow is not bound to this task's current goalVersion");
  }
  if (!Array.isArray(plan.nodes) || plan.nodes.length === 0) fail("invalid_field", "workflow.nodes must be a non-empty array");
  if (plan.nodes.length > MAX_WORKFLOW_NODES) fail("field_too_large", `workflow has more than ${MAX_WORKFLOW_NODES} nodes`);
  plan.nodes.forEach((node, i) => validateNode(node, i, binding));
  const ids = new Set();
  for (const node of plan.nodes) {
    if (ids.has(node.id)) fail("duplicate_node", `node id ${node.id} appears twice`);
    ids.add(node.id);
  }
  for (const node of plan.nodes) {
    for (const dep of node.dependsOn) {
      if (dep === node.id) fail("workflow_cycle", `node ${node.id} depends on itself`);
      if (!ids.has(dep)) fail("unknown_dependency", `node ${node.id} depends on unknown node ${dep}`);
    }
  }
  const order = topologicalOrder(plan.nodes);
  return deepFreeze({ ...JSON.parse(JSON.stringify(plan)), order });
}

function nodeIdempotencyKey({ workflowId, revision, nodeId, attempt }) {
  return `wf:${workflowId}:r${revision}:${nodeId}:a${attempt}`;
}

const SETTLED = new Set([...OUTCOMES, "blocked"]);

class WorkflowState {
  constructor(validPlan) {
    if (!validPlan || !Object.isFrozen(validPlan) || !Array.isArray(validPlan.order)) fail("invalid_field", "WorkflowState needs a plan from validateWorkflowPlan");
    this._plan = validPlan;
    this._nodes = new Map(validPlan.nodes.map((n) => [n.id, { def: n, status: "pending", attempt: 0 }]));
  }

  // Rebuilds state from host-recorded node events in journal order. A start
  // with no result is uncertain afterwards and is never re-run automatically.
  static replay(validPlan, records) {
    const state = new WorkflowState(validPlan);
    for (const record of records) {
      if (record?.type === "workflow_node_started") state.recordStarted(record);
      else if (record?.type === "workflow_node_result") state.recordResult(record);
      else fail("invalid_field", "replay accepts only workflow_node_started/result records");
    }
    for (const entry of state._nodes.values()) if (entry.status === "running") entry.status = "uncertain";
    state._resolveBarriers();
    return state;
  }

  node(id) {
    const entry = this._nodes.get(id);
    return entry ? { id, type: entry.def.type, status: entry.status, attempt: entry.attempt } : null;
  }

  ready() {
    return this._plan.order.filter((id) => this._isReady(id));
  }

  recordStarted({ nodeId, attempt }) {
    const entry = this._nodes.get(nodeId);
    if (!entry || !this._isReady(nodeId)) fail("node_not_ready", `node ${nodeId} is not ready to start`);
    if (attempt !== entry.attempt + 1) fail("attempt_mismatch", `node ${nodeId} next attempt is ${entry.attempt + 1}`);
    entry.status = "running";
    entry.attempt = attempt;
  }

  recordResult({ nodeId, attempt, outcome }) {
    const entry = this._nodes.get(nodeId);
    if (!entry || entry.status !== "running") fail("node_not_started", `node ${nodeId} has no started attempt awaiting a result`);
    if (attempt !== entry.attempt) fail("attempt_mismatch", `node ${nodeId} is on attempt ${entry.attempt}`);
    if (!OUTCOMES.includes(outcome)) fail("unknown_enum", `outcome must be one of ${OUTCOMES.join("|")}`);
    entry.status = outcome;
    this._resolveBarriers();
  }

  status() {
    const entries = this._plan.order.map((id) => this._nodes.get(id));
    if (entries.every((e) => e.status === "succeeded")) return { state: "completed" };
    if (entries.some((e) => e.status === "running") || this.ready().length > 0) return { state: "running" };
    const stuck = this._plan.order.find((id) => {
      const e = this._nodes.get(id);
      if (e.status === "blocked") return true;
      return e.status === "pending" && e.def.dependsOn.some((d) => SETTLED.has(this._nodes.get(d).status) && this._nodes.get(d).status !== "succeeded");
    });
    return { state: "paused", reason: "workflow_dependency_failed", nodeId: stuck ?? null };
  }

  snapshot() {
    return {
      workflowId: this._plan.workflowId,
      revision: this._plan.revision,
      status: this.status(),
      nodes: this._plan.order.map((id) => this.node(id)),
    };
  }

  _isReady(id) {
    const entry = this._nodes.get(id);
    return !!entry && entry.def.type !== "barrier" && entry.status === "pending"
      && entry.def.dependsOn.every((d) => this._nodes.get(d).status === "succeeded");
  }

  // A barrier is passed by the host, never started: once every input has
  // settled it succeeds only if all succeeded, otherwise it blocks.
  _resolveBarriers() {
    for (const id of this._plan.order) {
      const entry = this._nodes.get(id);
      if (entry.def.type !== "barrier" || entry.status !== "pending") continue;
      const inputs = entry.def.dependsOn.map((d) => this._nodes.get(d).status);
      if (!inputs.every((s) => SETTLED.has(s))) continue;
      entry.status = inputs.every((s) => s === "succeeded") ? "succeeded" : "blocked";
    }
  }
}

module.exports = { validateWorkflowPlan, WorkflowState, WorkflowError, nodeIdempotencyKey, MAX_WORKFLOW_NODES, NODE_TYPES, OUTCOMES };
