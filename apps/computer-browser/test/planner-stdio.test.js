"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const { PlannerStdioAdapter, PlannerTransportError } = require("../main/harness/planner-stdio");
const { MAX_PLANNER_FRAME_BYTES } = require("../shared/harness-contracts");

const TASK_ID = "11111111-1111-1111-1111-111111111111";

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
  child.kill = () => {};
  return child;
}

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
