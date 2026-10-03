"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const { PlannerStdioAdapter, PlannerTransportError } = require("../main/harness/planner-stdio");
const { MAX_PLANNER_FRAME_BYTES, ContractError, validateProposalEnvelope } = require("../shared/harness-contracts");

const TASK_ID = "11111111-1111-1111-1111-111111111111";

test("real stdio failure returns before the 60s deadline and reaps its worker", { timeout: 5000 }, async () => {
  const adapter = new PlannerStdioAdapter({ command: process.execPath, args: [path.resolve(__dirname, "../fixtures/planner-failure-worker.cjs")], timeoutMs: 60_000 });
  try {
    await assert.rejects(adapter.next(makeContext()), { code: "planner_failed", plannerCode: "cli_error" });
    assert.ok(!adapter.getStderrTail().includes("synthetic-private-detail"));
  } finally { await adapter.close(); }
  assert.equal(adapter.isTerminating(), false);
  assert.equal(adapter._child, null);
});

test("a matching worker failure rejects immediately, retires the worker, and ignores stale errors", async () => {
  const child = makeFakeChild();
  const adapter = new PlannerStdioAdapter({ command: "node", timeoutMs: 60_000, spawnFn: () => child });
  const pending = adapter.next(makeContext());
  const check = assert.rejects(pending, { code: "planner_failed", plannerCode: "cli_error" });
  const { requestId } = JSON.parse(child.stdin.written[0]);
  child.stdout.emit("data", JSON.stringify({ requestId: "old", error: { code: "cli_error" } }) + "\n");
  assert.ok(adapter._inFlight);
  child.stdout.emit("data", JSON.stringify({ requestId, error: { code: "cli_error" } }) + "\n");
  await check;
  assert.equal(adapter._child, null);
  await adapter.close();
});

test("ambiguous or unbounded worker errors are never accepted as proposals", async () => {
  for (const extra of [ { error: { code: "cli_error", message: "secret" } }, { error: { code: "unknown" } }, { error: { code: "cli_error" }, proposal: { ok: true } } ]) {
    const child = makeFakeChild();
    const adapter = new PlannerStdioAdapter({ command: "node", spawnFn: () => child });
    const pending = adapter.next(makeContext());
    const check = assert.rejects(pending, { code: "invalid_response" });
    const { requestId } = JSON.parse(child.stdin.written[0]);
    child.stdout.emit("data", JSON.stringify({ requestId, ...extra }) + "\n");
    await check;
    await adapter.close();
  }
});

function makeContext(overrides = {}) {
  return {
    taskId: TASK_ID,
    goalVersion: 1,
    goal: { originalRequest: "goal", amendments: [], constraints: [], criteria: [{ id: "C1" }] },
    progress: {},
    recentEvents: [],
    observation: null,
    untrustedSummary: null,
    ...overrides,
  };
}

// A minimal fake child_process.ChildProcess: EventEmitter + writable stdin
// (records what was written) + readable stdout/stderr (feed lines with
// .stdout.emit("data", ...)) + kill().
function makeFakeChild() {
  const child = new EventEmitter();
  child.stdin = { written: [], write: (data, enc, cb) => { child.stdin.written.push(data); if (cb) cb(); }, end: () => {} };
  child.stdout = new EventEmitter();
  child.stdout.setEncoding = () => {};
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  child.kill = () => { child.emit("exit", null, "SIGTERM"); return true; };
  return child;
}

test("retired worker events cannot corrupt a replacement request", async () => {
  const oldChild = makeFakeChild();
  const newChild = makeFakeChild();
  const children = [oldChild, newChild];
  const adapter = new PlannerStdioAdapter({ command: "node", spawnFn: () => children.shift() });
  adapter.warm();
  oldChild.stdout.emit("data", "unfinished");
  await adapter.close();
  const pending = adapter.next(makeContext());
  const rejection = pending.catch((error) => error);
  const { requestId } = JSON.parse(newChild.stdin.written[0]);
  oldChild.stdout.emit("data", "malformed\n");
  oldChild.emit("exit", 0);
  newChild.stdout.emit("data", `${JSON.stringify({ requestId, proposal: { ok: true } })}\n`);
  assert.deepEqual(await rejection, { ok: true });
  assert.equal(adapter._child, newChild);
  await adapter.close();
});

test("planner stdio preserves the exact mcp_* action proposal envelope", async () => {
  const child = makeFakeChild();
  const adapter = new PlannerStdioAdapter({ command: "node", spawnFn: () => child });
  const action = { type: "mcp_search", query: "calendar" };
  const pending = adapter.next(makeContext());
  const { requestId } = JSON.parse(child.stdin.written[0]);
  const proposal = {
    taskId: TASK_ID, goalVersion: 1, basedOnObservationId: "obs-1", criterionIds: [],
    kind: "actions", actions: [action],
  };
  child.stdout.emit("data", `${JSON.stringify({ requestId, proposal })}\n`);
  assert.deepEqual(await pending, proposal);
  await adapter.close();
});

test("planner stdio rejects mixed or malformed mcp_* actions", async () => {
  const invalidProposals = [
    { kind: "actions", actions: [{ type: "mcp_search", query: "x", extra: true }] },
    { kind: "actions", actions: [{ type: "mcp_search", query: "x" }, { type: "observe" }] },
    { kind: "actions", actions: [{ type: "mcp_propose", connectionId: "c", toolName: "t", arguments: {}, reason: "" }] },
  ];
  for (const partial of invalidProposals) {
    const child = makeFakeChild();
    const adapter = new PlannerStdioAdapter({ command: "node", spawnFn: () => child });
    const pending = adapter.next(makeContext());
    const { requestId } = JSON.parse(child.stdin.written[0]);
    child.stdout.emit("data", `${JSON.stringify({ requestId, proposal: {
      taskId: TASK_ID, goalVersion: 1, basedOnObservationId: "obs-1", criterionIds: [], ...partial,
    } })}\n`);
    await assert.rejects(pending, { code: "invalid_response" });
    await adapter.close();
  }
});

test("oversized complete and incomplete UTF-8 response frames are rejected before parsing", async () => {
  for (const complete of [true, false]) {
    const child = makeFakeChild();
    const adapter = new PlannerStdioAdapter({ command: "node", spawnFn: () => child });
    const pending = adapter.next(makeContext());
    const check = assert.rejects(pending, { code: "frame_too_large" });
    const { requestId } = JSON.parse(child.stdin.written[0]);
    const line = JSON.stringify({ requestId, proposal: { text: "한".repeat(Math.ceil(MAX_PLANNER_FRAME_BYTES / 3)) } });
    assert.ok(line.length < MAX_PLANNER_FRAME_BYTES);
    child.stdout.emit("data", line + (complete ? "\n" : ""));
    await check;
    await adapter.close();
  }
});

test("stderr diagnostic tail is bounded in UTF-8 bytes", async () => {
  const child = makeFakeChild();
  const adapter = new PlannerStdioAdapter({ command: "node", spawnFn: () => child });
  adapter.warm();
  child.stderr.emit("data", "한".repeat(4096));
  const tail = adapter.getStderrTail();
  assert.ok(Buffer.byteLength(tail, "utf8") <= 4096);
  assert.ok(!tail.includes("\uFFFD"));
  await adapter.close();
});

test("late write errors belong only to their original request", async () => {
  const child = makeFakeChild();
  const callbacks = [];
  child.stdin.write = (data, encoding, callback) => { child.stdin.written.push(data); callbacks.push(callback); };
  const adapter = new PlannerStdioAdapter({ command: "node", spawnFn: () => child });
  const first = adapter.next(makeContext());
  const firstId = JSON.parse(child.stdin.written[0]).requestId;
  child.stdout.emit("data", `${JSON.stringify({ requestId: firstId, proposal: { first: true } })}\n`);
  await first;
  const second = adapter.next(makeContext());
  const secondId = JSON.parse(child.stdin.written[1]).requestId;
  callbacks[0](new Error("delayed write error"));
  child.stdout.emit("data", `${JSON.stringify({ requestId: secondId, proposal: { second: true } })}\n`);
  assert.deepEqual(await second, { second: true });
  await adapter.close();
});

test("oversized partial frame suffix is drained before accepting the next reply", async () => {
  const child = makeFakeChild();
  const adapter = new PlannerStdioAdapter({ command: "node", spawnFn: () => child });
  const first = adapter.next(makeContext());
  const check = assert.rejects(first, { code: "frame_too_large" });
  child.stdout.emit("data", "x".repeat(MAX_PLANNER_FRAME_BYTES + 1));
  await check;
  assert.equal(adapter._stdoutBuffer, "");
  const second = adapter.next(makeContext());
  const requestId = JSON.parse(child.stdin.written[1]).requestId;
  child.stdout.emit("data", "old suffix");
  assert.equal(adapter._stdoutBuffer, "");
  child.stdout.emit("data", `\n${JSON.stringify({ requestId, proposal: { ok: true } })}\n`);
  assert.deepEqual(await second, { ok: true });
  await adapter.close();
});

test("timeout retires the worker and waits for exit before a resumed request", async () => {
  const oldChild = makeFakeChild();
  const newChild = makeFakeChild();
  const signals = [];
  oldChild.kill = (signal) => { signals.push(signal); return true; };
  const children = [oldChild, newChild];
  let starts = 0;
  const adapter = new PlannerStdioAdapter({ command: "node", timeoutMs: 10, workerExitTimeoutMs: 1000,
    spawnFn: () => { starts += 1; return children.shift(); } });
  await assert.rejects(adapter.next(makeContext()), { code: "timeout" });
  assert.deepEqual(signals, ["SIGTERM"]);
  const resumed = adapter.next(makeContext({ progress: { completed: ["C1"] } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1, "replacement must not overlap the retired worker");
  oldChild.emit("exit", null, "SIGTERM");
  await new Promise((resolve) => setImmediate(resolve));
  const request = JSON.parse(newChild.stdin.written[0]);
  assert.deepEqual(request.context.progress, { completed: ["C1"] });
  newChild.stdout.emit("data", `${JSON.stringify({ requestId: request.requestId, proposal: { ok: true } })}\n`);
  assert.deepEqual(await resumed, { ok: true });
  await adapter.close();
});

test("abort and close share a shutdown barrier that resolves only after exit", async () => {
  const child = makeFakeChild();
  let kills = 0;
  child.kill = () => { kills += 1; return true; };
  const adapter = new PlannerStdioAdapter({ command: "node", spawnFn: () => child, workerExitTimeoutMs: 1000 });
  const aborter = new AbortController();
  const request = adapter.next(makeContext(), { signal: aborter.signal });
  const aborted = assert.rejects(request, { code: "aborted" });
  aborter.abort();
  await aborted;
  let closed = false;
  const closing = adapter.close().then(() => { closed = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(kills, 1);
  assert.equal(closed, false);
  child.emit("exit", null, "SIGTERM");
  await closing;
  assert.equal(closed, true);
});

test("unconfirmed termination fails closed until a late exit is actually observed", async () => {
  const oldChild = makeFakeChild();
  const newChild = makeFakeChild();
  oldChild.kill = () => false;
  const children = [oldChild, newChild];
  let starts = 0;
  const adapter = new PlannerStdioAdapter({ command: "node", workerExitTimeoutMs: 10,
    spawnFn: () => { starts += 1; return children.shift(); } });
  adapter.warm();
  await assert.rejects(adapter.close(), { code: "worker_termination_timeout" });
  await assert.rejects(adapter.next(makeContext()), { code: "worker_termination_timeout" });
  assert.throws(() => adapter.warm(), { code: "worker_termination_timeout" });
  assert.equal(starts, 1);
  oldChild.emit("exit", null, "SIGTERM");
  const resumed = adapter.next(makeContext());
  const { requestId } = JSON.parse(newChild.stdin.written[0]);
  newChild.stdout.emit("data", `${JSON.stringify({ requestId, proposal: { ok: true } })}\n`);
  assert.deepEqual(await resumed, { ok: true });
  await adapter.close();
});

test("already aborted requests neither spawn a worker nor spend a model call", async () => {
  let starts = 0;
  const adapter = new PlannerStdioAdapter({ command: "node", spawnFn: () => { starts += 1; return makeFakeChild(); } });
  const aborter = new AbortController();
  aborter.abort();
  await assert.rejects(adapter.next(makeContext(), { signal: aborter.signal }), { code: "aborted" });
  assert.equal(starts, 0);
  await adapter.close();
});

test("real worker cancellation reaps the process before replacement", { timeout: 10000 }, async (t) => {
  const { spawn } = require("node:child_process");
  let ready;
  const initialized = new Promise((resolve) => { ready = resolve; });
  const workers = [];
  const adapter = new PlannerStdioAdapter({ command: process.execPath, workerExitTimeoutMs: 4000,
    spawnFn: (command, args, options) => {
      const first = workers.length === 0;
      const program = first ? `
        setInterval(() => {}, 1000);
        process.on('SIGTERM', () => setTimeout(() => process.exit(0), 60));
        process.stderr.write('READY\\n');
      ` : `
        require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
          const request = JSON.parse(line);
          process.stdout.write(JSON.stringify({ requestId: request.requestId, proposal: { ok: true } }) + '\\n');
        });
      `;
      const child = spawn(command, ["-e", program], options);
      workers.push(child);
      if (first) child.stderr.once("data", () => ready());
      return child;
    } });
  t.after(async () => {
    // These are only this test's own disposable workers, never other agents.
    for (const worker of workers) {
      if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL");
    }
    await adapter.close();
  });
  const aborter = new AbortController();
  const pending = adapter.next(makeContext(), { signal: aborter.signal });
  const rejected = assert.rejects(pending, { code: "aborted" });
  await initialized;
  aborter.abort();
  await rejected;
  const resumed = adapter.next(makeContext());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(workers.length, 1);
  assert.deepEqual(await resumed, { ok: true });
  assert.equal(workers.length, 2);
  assert.equal(workers[0].exitCode, 0, "graceful shutdown must be observed before replacement");
  await adapter.close();
  assert.notEqual(workers[1].exitCode ?? workers[1].signalCode, null);
});

test("live worker error does not masquerade as confirmed exit or release memory accounting", async () => {
  const child = makeFakeChild();
  child.pid = 4321;
  child.kill = () => false;
  let exits = 0;
  const adapter = new PlannerStdioAdapter({ command: "node", spawnFn: () => child,
    workerExitTimeoutMs: 10, onWorkerExit: () => { exits += 1; } });
  const pending = adapter.next(makeContext());
  const failure = assert.rejects(pending, { code: "planner_unavailable" });
  child.emit("error", new Error("signal failed"));
  await failure;
  await assert.rejects(adapter.close(), { code: "worker_termination_timeout" });
  assert.equal(exits, 0);
  child.emit("exit", null, "SIGTERM");
  assert.equal(exits, 1);
  await adapter.close();
});

test("invalid shutdown deadlines cannot disable bounded termination", () => {
  for (const workerExitTimeoutMs of [0, -1, Infinity, NaN, 1.5, 60001, "10", null]) {
    assert.throws(() => new PlannerStdioAdapter({ workerExitTimeoutMs }), { code: "invalid_config" });
  }
});

test("stdin stream errors retire the worker without crashing the host", async () => {
  const child = makeFakeChild();
  const stdin = new EventEmitter();
  Object.assign(stdin, child.stdin);
  child.stdin = stdin;
  const adapter = new PlannerStdioAdapter({ command: "node", spawnFn: () => child });
  const pending = adapter.next(makeContext());
  const result = pending.catch((error) => error);
  let uncaught;
  try { stdin.emit("error", new Error("EPIPE")); } catch (error) { uncaught = error; }
  await adapter.close();
  assert.equal(uncaught, undefined, "stream failure must not escape the host event loop");
  assert.equal((await result).code, "transport_write_failed");
});

test("long task takeover drains its planner before resume without replaying completed work", async (t) => {
  const fs = require("node:fs/promises");
  const os = require("node:os");
  const { TaskStore } = require("../main/harness/task-store");
  const { TaskController } = require("../main/harness/task-controller");
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-planner-resume-"));
  const store = await TaskStore.create({ originalRequest: "장기 목표 유지",
    criteria: [{ id: "C1", text: "observe once", required: true, verification: "host" }] }, { storageRoot });
  const oldChild = makeFakeChild();
  const newChild = makeFakeChild();
  let kills = 0;
  oldChild.kill = () => { kills += 1; return true; };
  const children = [oldChild, newChild];
  const adapter = new PlannerStdioAdapter({ command: "node", timeoutMs: 1000, workerExitTimeoutMs: 1000,
    spawnFn: () => children.shift() });
  t.after(async () => {
    oldChild.emit("exit", null, "SIGTERM");
    await adapter.close();
    await store.close();
    await fs.rm(storageRoot, { recursive: true, force: true });
  });
  let entered;
  const waiting = new Promise((resolve) => { entered = resolve; });
  let requests = 0;
  oldChild.stdin.write = (data, encoding, callback) => {
    oldChild.stdin.written.push(data);
    callback?.();
    const { requestId, context } = JSON.parse(data);
    requests += 1;
    if (requests === 2) { entered(); return; }
    oldChild.stdout.emit("data", `${JSON.stringify({ requestId, proposal: {
      taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id,
      kind: "actions", criterionIds: ["C1"], actions: [{ type: "observe" }],
    } })}\n`);
  };
  let resumedContext;
  newChild.stdin.write = (data, encoding, callback) => {
    newChild.stdin.written.push(data);
    callback?.();
    const { requestId, context } = JSON.parse(data);
    resumedContext = context;
    newChild.stdout.emit("data", `${JSON.stringify({ requestId, proposal: {
      taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id,
      kind: "finish", criterionIds: [], evidenceIds: [],
    } })}\n`);
  };
  let observations = 0;
  let executions = 0;
  const controller = new TaskController({ store, planner: adapter, harnessProfile: "long",
    browser: { observe: async () => ({ id: `obs-${++observations}` }),
      execute: async () => { executions += 1; return { status: "ok",
        evidenceCandidate: { kind: "host_check", observationId: "obs-1", artifactHash: "a".repeat(64) } }; } },
    approve: async () => ({ decision: "allow", reasons: [] }), hostVerifier: () => true });
  const running = controller.start();
  await waiting;
  let released = false;
  const takeover = controller.takeOver().then(() => { released = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(kills, 1, "user takeover must abort the outstanding planner call");
  assert.equal(released, false, "takeover cannot release control before worker exit");
  oldChild.emit("exit", null, "SIGTERM");
  await takeover;
  await running;
  const paused = controller.getSnapshot();
  assert.equal(paused.state, "paused");
  assert.equal(paused.budgets.actionsUsed, 1);
  await controller.resume();
  assert.equal(controller.getSnapshot().state, "completed", JSON.stringify(controller.getSnapshot()));
  assert.equal(controller.getGoal().originalRequest, "장기 목표 유지");
  assert.equal(resumedContext.goal.originalRequest, "장기 목표 유지");
  assert.equal(controller.getSnapshot().budgets.actionsUsed, 1);
  assert.equal(executions, 1, "completed action must not be replayed");
  assert.equal(controller.getSnapshot().budgets.plannerCallsUsed, 3);
});

test("cancelled planner turns consume durable call budget and cannot be retried past the limit", async (t) => {
  const fs = require("node:fs/promises");
  const os = require("node:os");
  const { TaskStore } = require("../main/harness/task-store");
  const { TaskController } = require("../main/harness/task-controller");
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-planner-budget-"));
  const store = await TaskStore.create({ originalRequest: "bounded long task",
    limits: { maxPlannerCalls: 1 } }, { storageRoot });
  t.after(async () => { await store.close(); await fs.rm(storageRoot, { recursive: true, force: true }); });
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  let calls = 0;
  const controller = new TaskController({ store, harnessProfile: "long",
    planner: { next: () => { calls += 1; entered(); return new Promise(() => {}); }, close: async () => {} },
    browser: { observe: async () => ({ id: "obs" }), execute: async () => { throw new Error("must not dispatch"); } },
    approve: async () => ({ decision: "deny", reasons: [] }), hostVerifier: () => false });
  const running = controller.start();
  await ready;
  await controller.pause();
  await running;
  assert.equal(controller.getSnapshot().budgets.plannerCallsUsed, 1);
  assert.equal(store.lastCheckpoint.payload.budgets.plannerCallsUsed, 1);
  await controller.resume();
  assert.equal(controller.getSnapshot().pauseReason, "budget_exhausted");
  assert.equal(calls, 1);
});

test("failed planner shutdown keeps controller admission closed until a successful transition retry", async (t) => {
  const fs = require("node:fs/promises");
  const os = require("node:os");
  const { TaskStore } = require("../main/harness/task-store");
  const { TaskController } = require("../main/harness/task-controller");
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-planner-gate-"));
  const store = await TaskStore.create({ originalRequest: "fail closed recovery" }, { storageRoot });
  t.after(async () => { await store.close(); await fs.rm(storageRoot, { recursive: true, force: true }); });
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  let failClose = true;
  let calls = 0;
  const controller = new TaskController({ store, harnessProfile: "long",
    planner: { next: (context) => {
      calls += 1;
      if (calls === 1) { entered(); return new Promise(() => {}); }
      return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id,
        kind: "need_user", criterionIds: [], reason: "inspect next step" };
    }, close: async () => { if (failClose) throw new PlannerTransportError("worker_termination_timeout", "unconfirmed exit"); } },
    browser: { observe: async () => ({ id: "obs" }), execute: async () => { throw new Error("must not dispatch"); } },
    approve: async () => ({ decision: "deny", reasons: [] }), hostVerifier: () => false });
  const running = controller.start();
  await ready;
  await assert.rejects(controller.takeOver(), { code: "worker_termination_timeout" });
  await running;
  await assert.rejects(controller.resume(), { code: "admission_closed" });
  assert.equal(calls, 1);
  failClose = false;
  await controller.takeOver();
  assert.equal(controller.getSnapshot().state, "paused");
  await controller.resume();
  assert.equal(calls, 2);
  assert.equal(controller.getGoal().originalRequest, "fail closed recovery");
});

for (const transition of ["stop", "pause", "takeOver"]) test(`${transition} after a planner timeout still waits for the previously retired worker`, async (t) => {
  const fs = require("node:fs/promises");
  const os = require("node:os");
  const { TaskStore } = require("../main/harness/task-store");
  const { TaskController } = require("../main/harness/task-controller");
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-timeout-stop-"));
  const store = await TaskStore.create({ originalRequest: "confirm timed out worker exit" }, { storageRoot });
  const child = makeFakeChild();
  child.kill = () => true;
  const adapter = new PlannerStdioAdapter({ command: "node", timeoutMs: 10, workerExitTimeoutMs: 1000, spawnFn: () => child });
  t.after(async () => {
    child.emit("exit", null, "SIGTERM");
    await adapter.close();
    await store.close();
    await fs.rm(storageRoot, { recursive: true, force: true });
  });
  const controller = new TaskController({ store, planner: adapter,
    browser: { observe: async () => ({ id: "obs" }), execute: async () => { throw new Error("must not dispatch"); } },
    approve: async () => ({ decision: "deny", reasons: [] }), hostVerifier: () => false });
  await controller.start();
  assert.equal(controller.getSnapshot().pauseReason, "planner_error");
  let closes = 0;
  const close = adapter.close.bind(adapter);
  adapter.close = () => { closes += 1; return close(); };
  let stopped = false;
  const stopping = controller[transition]().then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closes, 1, `${transition} must drain retirement even after the request already timed out`);
  assert.equal(stopped, false);
  child.emit("exit", null, "SIGTERM");
  await stopping;
  assert.equal(controller.getSnapshot().state, transition === "stop" ? "stopped" : "paused");
});

test("with no command configured, next() rejects planner_unavailable instead of fabricating a proposal", async () => {
  const adapter = new PlannerStdioAdapter({});
  await assert.rejects(
    () => adapter.next(makeContext(), {}),
    (err) => err instanceof PlannerTransportError && err.code === "planner_unavailable",
  );
});

test("spawns with shell:false, argv from host config, and an env allowlist that excludes app secrets", async () => {
  let capturedArgs;
  const savedKey = process.env.HALO_APPROVER_KEY;
  process.env.HALO_APPROVER_KEY = "super-secret-should-never-leak";
  try {
    const fakeChild = makeFakeChild();
    const spawnFn = (command, args, options) => {
      capturedArgs = { command, args, options };
      return fakeChild;
    };
    const adapter = new PlannerStdioAdapter({ command: "node", args: ["worker.js"], spawnFn });
    const pending = adapter.next(makeContext(), {});
    // Let the microtask queue settle so _ensureChild() has run.
    await Promise.resolve();

    assert.equal(capturedArgs.command, "node");
    assert.deepEqual(capturedArgs.args, ["worker.js"]);
    assert.equal(capturedArgs.options.shell, false);
    assert.equal("HALO_APPROVER_KEY" in capturedArgs.options.env, false);

    const sentRequest = JSON.parse(fakeChild.stdin.written[0]);
    fakeChild.stdout.emit("data", `${JSON.stringify({ requestId: sentRequest.requestId, proposal: { ok: true } })}\n`);
    const proposal = await pending;
    assert.deepEqual(proposal, { ok: true });
    await adapter.close();
  } finally {
    process.env.HALO_APPROVER_KEY = savedKey;
  }
});

test("warm() starts the configured worker early and next() reuses that child", async () => {
  const fakeChild = makeFakeChild();
  let spawnCount = 0;
  const adapter = new PlannerStdioAdapter({
    command: "node",
    args: [],
    spawnFn: () => { spawnCount += 1; return fakeChild; },
  });

  assert.equal(adapter.warm(), true);
  assert.equal(spawnCount, 1);
  const pending = adapter.next(makeContext(), {});
  const sentRequest = JSON.parse(fakeChild.stdin.written[0]);
  fakeChild.stdout.emit("data", `${JSON.stringify({ requestId: sentRequest.requestId, proposal: { ok: true } })}\n`);

  assert.deepEqual(await pending, { ok: true });
  assert.equal(spawnCount, 1);
  await adapter.close();
});

test("planner image attachments travel out-of-band from context and are bounded to one host path", async () => {
  const child = makeFakeChild();
  const adapter = new PlannerStdioAdapter({ command: "node", spawnFn: () => child });
  const attachment = { kind: "image", id: "22222222-2222-4222-8222-222222222222", path: "/tmp/halo-computer-use-id/observation.png" };
  const pending = adapter.next(makeContext(), { attachments: [attachment] });
  const frame = JSON.parse(child.stdin.written[0]);
  assert.deepEqual(frame.attachments, [attachment]);
  assert.equal(Object.hasOwn(frame.context, "attachments"), false);
  assert.equal(JSON.stringify(frame.context).includes(attachment.path), false);
  child.stdout.emit("data", `${JSON.stringify({ requestId: frame.requestId, proposal: { ok: true } })}\n`);
  assert.deepEqual(await pending, { ok: true });
  await adapter.close();
});

test("malformed, caller-expanded, or multiple image attachments are rejected before worker spawn", async () => {
  let spawns = 0;
  const adapter = new PlannerStdioAdapter({ command: "node", spawnFn: () => { spawns += 1; return makeFakeChild(); } });
  for (const attachments of [
    [{ kind: "image", id: "not-a-uuid", path: "/tmp/a.png" }],
    [{ kind: "image", id: "22222222-2222-4222-8222-222222222222", path: "relative.png" }],
    Array.from({ length: 2 }, (_, i) => ({ kind: "image", id: `22222222-2222-4222-8222-22222222222${i}`, path: `/tmp/${i}.png` })),
  ]) await assert.rejects(adapter.next(makeContext(), { attachments }), { code: "invalid_attachment" });
  assert.equal(spawns, 0);
  await adapter.close();
});

test("reports planner worker start and exit so host memory accounting includes its RSS", async () => {
  const child = makeFakeChild();
  child.pid = 4321;
  const lifecycle = [];
  const adapter = new PlannerStdioAdapter({
    command: "node",
    spawnFn: () => child,
    onWorkerStart: (processInfo) => lifecycle.push({ event: "start", ...processInfo }),
    onWorkerExit: (processInfo) => lifecycle.push({ event: "exit", ...processInfo }),
  });

  adapter.warm();
  assert.equal(lifecycle.length, 1);
  assert.equal(lifecycle[0].event, "start");
  assert.equal(lifecycle[0].pid, 4321);
  assert.equal(typeof lifecycle[0].creationTime, "number");

  child.emit("exit", 0);
  assert.deepEqual(lifecycle.slice(1), [{ event: "exit", pid: 4321, creationTime: lifecycle[0].creationTime }]);
  await adapter.close();
});

test("refuses to spawn a worker whose caller-supplied env carries a secret-shaped key", async () => {
  const fakeChild = makeFakeChild();
  const adapter = new PlannerStdioAdapter({
    command: "node",
    args: [],
    env: { HALO_EXECUTOR_KEY: "leak" },
    spawnFn: () => fakeChild,
  });
  await assert.rejects(
    () => adapter.next(makeContext(), {}),
    (err) => err instanceof PlannerTransportError && err.code === "invalid_config",
  );
});

test("ignores a wrong-requestId reply and still resolves once the real one arrives", async () => {
  const fakeChild = makeFakeChild();
  const adapter = new PlannerStdioAdapter({ command: "node", args: [], spawnFn: () => fakeChild });
  const pending = adapter.next(makeContext(), {});
  await Promise.resolve();
  const sentRequest = JSON.parse(fakeChild.stdin.written[0]);

  fakeChild.stdout.emit("data", `${JSON.stringify({ requestId: "not-the-real-id", proposal: { impostor: true } })}\n`);
  // Give the wrong reply a chance to be (incorrectly) accepted, if it were going to be.
  await new Promise((r) => setImmediate(r));

  fakeChild.stdout.emit("data", `${JSON.stringify({ requestId: sentRequest.requestId, proposal: { real: true } })}\n`);
  const proposal = await pending;
  assert.deepEqual(proposal, { real: true });
  await adapter.close();
});

test("a duplicate reply for an already-resolved request is dropped, not double-resolved", async () => {
  const fakeChild = makeFakeChild();
  const adapter = new PlannerStdioAdapter({ command: "node", args: [], spawnFn: () => fakeChild });
  const pending = adapter.next(makeContext(), {});
  await Promise.resolve();
  const sentRequest = JSON.parse(fakeChild.stdin.written[0]);

  fakeChild.stdout.emit("data", `${JSON.stringify({ requestId: sentRequest.requestId, proposal: { first: true } })}\n`);
  const proposal = await pending;
  assert.deepEqual(proposal, { first: true });

  // A second, duplicate line for the same (now-completed) requestId must not throw.
  fakeChild.stdout.emit("data", `${JSON.stringify({ requestId: sentRequest.requestId, proposal: { second: true } })}\n`);
  await adapter.close();
});

test("rejects with timeout if no response arrives in time, and does not resolve a late response afterward", async () => {
  const fakeChild = makeFakeChild();
  const adapter = new PlannerStdioAdapter({ command: "node", args: [], spawnFn: () => fakeChild, timeoutMs: 20 });
  const sentPromise = adapter.next(makeContext(), {});
  await assert.rejects(sentPromise, (err) => err instanceof PlannerTransportError && err.code === "timeout");

  // A late reply arriving after the timeout must be dropped silently.
  const sentRequest = JSON.parse(fakeChild.stdin.written[0]);
  assert.doesNotThrow(() => {
    fakeChild.stdout.emit("data", `${JSON.stringify({ requestId: sentRequest.requestId, proposal: { late: true } })}\n`);
  });
  await adapter.close();
});

test("rejects transport_busy when a second request is issued while one is already in flight", async () => {
  const fakeChild = makeFakeChild();
  const adapter = new PlannerStdioAdapter({ command: "node", args: [], spawnFn: () => fakeChild });
  const first = adapter.next(makeContext(), {});
  await Promise.resolve();
  await assert.rejects(
    () => adapter.next(makeContext(), {}),
    (err) => err instanceof PlannerTransportError && err.code === "transport_busy",
  );
  const sentRequest = JSON.parse(fakeChild.stdin.written[0]);
  fakeChild.stdout.emit("data", `${JSON.stringify({ requestId: sentRequest.requestId, proposal: {} })}\n`);
  await first;
  await adapter.close();
});

test("rejects an outgoing request whose framed size exceeds the frame limit", async () => {
  const fakeChild = makeFakeChild();
  const adapter = new PlannerStdioAdapter({ command: "node", args: [], spawnFn: () => fakeChild });
  const hugeContext = makeContext({ observation: { blob: "x".repeat(MAX_PLANNER_FRAME_BYTES) } });
  await assert.rejects(
    () => adapter.next(hugeContext, {}),
    (err) => err instanceof PlannerTransportError && err.code === "frame_too_large",
  );
});

test("rejects an incoming response line that exceeds the frame limit", async () => {
  const fakeChild = makeFakeChild();
  const adapter = new PlannerStdioAdapter({ command: "node", args: [], spawnFn: () => fakeChild });
  const pending = adapter.next(makeContext(), {});
  await Promise.resolve();
  fakeChild.stdout.emit("data", `${"x".repeat(MAX_PLANNER_FRAME_BYTES + 100)}`); // no newline yet: still buffering
  await assert.rejects(pending, (err) => err instanceof PlannerTransportError && err.code === "frame_too_large");
  await adapter.close();
});

test("rejects the in-flight request when the worker process exits unexpectedly (transport_closed)", async () => {
  const fakeChild = makeFakeChild();
  const adapter = new PlannerStdioAdapter({ command: "node", args: [], spawnFn: () => fakeChild });
  const pending = adapter.next(makeContext(), {});
  await Promise.resolve();
  fakeChild.emit("exit", 1);
  await assert.rejects(pending, (err) => err instanceof PlannerTransportError && err.code === "transport_closed");
});

test("real end-to-end: the scripted-planner.js example worker answers over real stdio pipes", async () => {
  const adapter = new PlannerStdioAdapter({
    command: process.execPath,
    args: [path.join(__dirname, "..", "fixtures", "scripted-planner.js")],
  });
  const context = makeContext({ goal: { originalRequest: "g", amendments: [], constraints: [], criteria: [{ id: "onlyC" }] } });
  const proposal = await adapter.next(context, {});
  assert.equal(proposal.kind, "actions");
  assert.deepEqual(proposal.criterionIds, ["onlyC"]);
  await adapter.close();
});

// --- Task 3 (multi-agent background runtime plan): a child agent's planner
// must never be able to spawn grandchildren. child_plan is a parent-only
// proposal kind; a child-role transport rejects it at the wire boundary
// rather than trusting the (untrusted, model-provider) worker process to
// police its own role.

test("constructor rejects an unknown role", () => {
  assert.throws(
    () => new PlannerStdioAdapter({ role: "grandparent" }),
    (err) => err instanceof PlannerTransportError && err.code === "invalid_config",
  );
});

test("defaults to role 'parent' when none is given", async () => {
  const fakeChild = makeFakeChild();
  const adapter = new PlannerStdioAdapter({ command: "node", args: [], spawnFn: () => fakeChild });
  const pending = adapter.next(makeContext(), {});
  await Promise.resolve();
  const sentRequest = JSON.parse(fakeChild.stdin.written[0]);
  const childPlanProposal = { kind: "child_plan", parentGoalVersion: 1, requestedAgentCount: 1, assignments: [] };
  fakeChild.stdout.emit("data", `${JSON.stringify({ requestId: sentRequest.requestId, proposal: childPlanProposal })}\n`);
  const proposal = await pending;
  assert.deepEqual(proposal, childPlanProposal);
  await adapter.close();
});

test("a role:'child' transport rejects a child_plan proposal from its worker (child_plan_forbidden)", async () => {
  const fakeChild = makeFakeChild();
  const adapter = new PlannerStdioAdapter({ command: "node", args: [], spawnFn: () => fakeChild, role: "child" });
  const pending = adapter.next(makeContext(), {});
  await Promise.resolve();
  const sentRequest = JSON.parse(fakeChild.stdin.written[0]);
  const childPlanProposal = { kind: "child_plan", parentGoalVersion: 1, requestedAgentCount: 1, assignments: [] };
  fakeChild.stdout.emit("data", `${JSON.stringify({ requestId: sentRequest.requestId, proposal: childPlanProposal })}\n`);
  await assert.rejects(pending, (err) => err instanceof PlannerTransportError && err.code === "child_plan_forbidden");
  await adapter.close();
});

test("a role:'child' transport still accepts an ordinary actions proposal", async () => {
  const fakeChild = makeFakeChild();
  const adapter = new PlannerStdioAdapter({ command: "node", args: [], spawnFn: () => fakeChild, role: "child" });
  const pending = adapter.next(makeContext(), {});
  await Promise.resolve();
  const sentRequest = JSON.parse(fakeChild.stdin.written[0]);
  const actionsProposal = { kind: "actions", actions: [{ type: "observe" }] };
  fakeChild.stdout.emit("data", `${JSON.stringify({ requestId: sentRequest.requestId, proposal: actionsProposal })}\n`);
  const proposal = await pending;
  assert.deepEqual(proposal, actionsProposal);
  await adapter.close();
});

// --- Subagent communication protocol Task 1: send_message proposal contract
// (spec section 6/14-4). Only SHAPE is checked here via
// contracts.validateProposalEnvelope() directly -- this adapter does not
// itself call the full validator (see the child_plan-only role gate above),
// so these are pure contract-level tests, matching how task-store.test.js
// exercises validateJournalEvent directly.

function baseSendMessageProposal(overrides = {}) {
  return {
    taskId: TASK_ID,
    goalVersion: 1,
    basedOnObservationId: "obs-1",
    criterionIds: [],
    kind: "send_message",
    recipientTaskId: "22222222-2222-2222-2222-222222222222",
    messageKind: "progress",
    idempotencyKey: "idem-1",
    text: "hello",
    ...overrides,
  };
}

test("validateProposalEnvelope accepts a well-formed send_message proposal", () => {
  assert.doesNotThrow(() => validateProposalEnvelope(baseSendMessageProposal()));
});

test("validateProposalEnvelope rejects a send_message proposal with an unknown messageKind", () => {
  assert.throws(
    () => validateProposalEnvelope(baseSendMessageProposal({ messageKind: "not_a_real_kind" })),
    (err) => err instanceof ContractError && err.code === "unknown_enum",
  );
});

test("validateProposalEnvelope rejects a send_message proposal that also carries actions-kind fields", () => {
  assert.throws(
    () => validateProposalEnvelope(baseSendMessageProposal({ actions: [{ type: "observe" }] })),
    (err) => err instanceof ContractError && err.code === "invalid_shape",
  );
});

test("validateProposalEnvelope rejects an actions proposal that smuggles in send_message fields", () => {
  assert.throws(
    () =>
      validateProposalEnvelope({
        taskId: TASK_ID,
        goalVersion: 1,
        basedOnObservationId: "obs-1",
        criterionIds: [],
        kind: "actions",
        actions: [{ type: "observe" }],
        recipientTaskId: "22222222-2222-2222-2222-222222222222",
      }),
    (err) => err instanceof ContractError && err.code === "invalid_shape",
  );
});

test("validateProposalEnvelope rejects a send_message proposal missing recipientTaskId", () => {
  const proposal = baseSendMessageProposal();
  delete proposal.recipientTaskId;
  assert.throws(
    () => validateProposalEnvelope(proposal),
    (err) => err instanceof ContractError,
  );
});

// --- Subagent communication protocol Task 3: planner role/direction gate.
// steer is a parent-to-child-only message kind (spec section 10); a child
// planner's own worker must never be trusted to police this itself, so the
// role:'child' transport rejects it at the wire boundary -- the same
// precedent as the child_plan_forbidden gate above. Recipient-relationship
// and stale-goal checks are out of scope here (no authoritative
// task-relationship view at this layer); those belong to the coordinator
// (Task 4).

test("a role:'child' transport rejects a send_message/steer proposal from its worker (steer_forbidden)", async () => {
  const fakeChild = makeFakeChild();
  const adapter = new PlannerStdioAdapter({ command: "node", args: [], spawnFn: () => fakeChild, role: "child" });
  const pending = adapter.next(makeContext(), {});
  await Promise.resolve();
  const sentRequest = JSON.parse(fakeChild.stdin.written[0]);
  const steerProposal = baseSendMessageProposal({ messageKind: "steer" });
  fakeChild.stdout.emit("data", `${JSON.stringify({ requestId: sentRequest.requestId, proposal: steerProposal })}\n`);
  await assert.rejects(pending, (err) => err instanceof PlannerTransportError && err.code === "steer_forbidden");
  await adapter.close();
});

test("a role:'child' transport still accepts a send_message proposal with a non-steer messageKind", async () => {
  const fakeChild = makeFakeChild();
  const adapter = new PlannerStdioAdapter({ command: "node", args: [], spawnFn: () => fakeChild, role: "child" });
  const pending = adapter.next(makeContext(), {});
  await Promise.resolve();
  const sentRequest = JSON.parse(fakeChild.stdin.written[0]);
  const progressProposal = baseSendMessageProposal({ messageKind: "progress" });
  fakeChild.stdout.emit("data", `${JSON.stringify({ requestId: sentRequest.requestId, proposal: progressProposal })}\n`);
  const proposal = await pending;
  assert.deepEqual(proposal, progressProposal);
  await adapter.close();
});

test("a role:'parent' transport still accepts a send_message/steer proposal from its worker", async () => {
  const fakeChild = makeFakeChild();
  const adapter = new PlannerStdioAdapter({ command: "node", args: [], spawnFn: () => fakeChild, role: "parent" });
  const pending = adapter.next(makeContext(), {});
  await Promise.resolve();
  const sentRequest = JSON.parse(fakeChild.stdin.written[0]);
  const steerProposal = baseSendMessageProposal({ messageKind: "steer" });
  fakeChild.stdout.emit("data", `${JSON.stringify({ requestId: sentRequest.requestId, proposal: steerProposal })}\n`);
  const proposal = await pending;
  assert.deepEqual(proposal, steerProposal);
  await adapter.close();
});

test("reports sanitized worker usage to onUsage and never fails a proposal because of it", async () => {
  const seen = [];
  for (const [usage, onUsage] of [
    [{ provider: "claude", inputTokens: 10, outputTokens: 5, costUsd: 0.01 }, (u) => seen.push(u)],
    [{ provider: "claude", inputTokens: 1 }, () => { throw new Error("ledger down"); }],
    [{ provider: "evil", inputTokens: 99 }, (u) => seen.push(u)],
  ]) {
    const fakeChild = makeFakeChild();
    const adapter = new PlannerStdioAdapter({ command: "node", args: [], spawnFn: () => fakeChild, onUsage });
    const pending = adapter.next(makeContext(), {});
    const sent = JSON.parse(fakeChild.stdin.written[0]);
    fakeChild.stdout.emit("data", `${JSON.stringify({ requestId: sent.requestId, proposal: { ok: true }, usage })}\n`);
    assert.deepEqual(await pending, { ok: true });
    await adapter.close();
  }
  assert.equal(seen.length, 1);
  assert.equal(seen[0].provider, "claude");
  assert.equal(seen[0].inputTokens, 10);
  assert.equal(seen[0].costUsd, 0.01);
});
