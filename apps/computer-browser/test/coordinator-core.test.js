"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const { CoordinatorCore } = require("../main/harness/coordinator-core");

function fakeQueue({ pending = [], active = [] } = {}) {
  const q = {
    pending: [...pending],
    active: [...active],
    pendingIds: () => [...q.pending],
    activeIds: () => [...q.active],
    admitNext: async ({ maxActive }) => {
      if (q.active.length >= maxActive || q.pending.length === 0) return null;
      const id = q.pending.shift();
      q.active.push(id);
      return id;
    },
  };
  return q;
}

function fakeAdmission({ admit = true } = {}) {
  const a = {
    acquired: [], released: [], admit,
    acquire: async (request) => {
      a.acquired.push(request);
      return a.admit ? { admitted: true, leaseId: `lease-${a.acquired.length}` } : { admitted: false };
    },
    release: async (leaseId) => { a.released.push(leaseId); },
  };
  return a;
}

function makeCore(overrides = {}) {
  const queue = overrides.queue || fakeQueue({ pending: ["t1", "t2", "t3"] });
  const admission = "admission" in overrides ? overrides.admission : fakeAdmission();
  const core = new CoordinatorCore({
    queue,
    ensureQueue: async () => {},
    getResourceAdmission: () => admission,
    getRunMemoryPolicy: async () => ({ mode: "budgeted" }),
    getExternalProcessHighWaterBytes: () => undefined,
    executionMode: "sequential",
    maxParallelTasks: 2,
    parallelTaskReserveBytes: 100,
    ...overrides.options,
  });
  return { core, queue, admission };
}

test("the module loads without electron, browser, planner, controller or host code", () => {
  const script = `
    require(${JSON.stringify(path.join(__dirname, "../main/harness/coordinator-core"))});
    process.stdout.write(JSON.stringify(Object.keys(require.cache)));
  `;
  const loaded = JSON.parse(execFileSync(process.execPath, ["-e", script], { encoding: "utf8" }));
  const forbidden = loaded.filter((file) => /electron|browser-adapter|browser-surfaces|planner|task-controller|task-host|frontend|renderer/i.test(file));
  assert.deepEqual(forbidden, []);
});

test("constructor rejects a missing queue or non-function hooks", () => {
  assert.throws(() => new CoordinatorCore({}), (e) => e.code === "invalid_config");
  assert.throws(() => new CoordinatorCore({ queue: fakeQueue(), ensureQueue: null }), (e) => e.code === "invalid_config");
});

test("sequential mode admits one task and records its lease", async () => {
  const { core, queue, admission } = makeCore();
  assert.equal(await core.admitNext(), "t1");
  assert.equal(core.hasLease("t1"), true);
  assert.equal(await core.admitNext(), null);
  assert.deepEqual(queue.active, ["t1"]);
  assert.equal(admission.acquired.length, 1);
  assert.equal(admission.acquired[0].ownerId, "t1");
  assert.equal(admission.acquired[0].reserveBytes, 100);
});

test("parallel mode admits up to maxParallelTasks then stops", async () => {
  const { core } = makeCore({ options: { executionMode: "parallel", maxParallelTasks: 2 } });
  assert.equal(await core.admitNext(), "t1");
  assert.equal(await core.admitNext(), "t2");
  assert.equal(await core.admitNext(), null);
});

test("a reservation finishing after teardown begins is released without admitting another task", async () => {
  const queue = fakeQueue({ pending: ["t1"] });
  let blocked = false;
  let signalAcquire;
  const acquireStarted = new Promise((resolve) => { signalAcquire = resolve; });
  let finishAcquire;
  const acquireGate = new Promise((resolve) => { finishAcquire = resolve; });
  const admission = {
    released: [],
    async acquire() { signalAcquire(); return acquireGate; },
    async release(leaseId) { this.released.push(leaseId); },
  };
  const { core } = makeCore({
    queue,
    admission,
    options: { executionMode: "parallel", isAdmissionBlocked: () => blocked },
  });

  const pending = core.admitNext();
  await acquireStarted;
  blocked = true;
  finishAcquire({ admitted: true, leaseId: "lease-t1" });

  assert.equal(await pending, null);
  assert.deepEqual(admission.released, ["lease-t1"]);
  assert.deepEqual(queue.active, []);
  assert.deepEqual(queue.pending, ["t1"]);
  assert.equal(core.hasLease("t1"), false);
});

test("a denied memory lease admits nothing and leaves the queue untouched", async () => {
  const { core, queue } = makeCore({ admission: fakeAdmission({ admit: false }) });
  assert.equal(await core.admitNext(), null);
  assert.deepEqual(queue.pending, ["t1", "t2", "t3"]);
  assert.equal(core.hasLease("t1"), false);
});

test("without a resource admission the queue admits one task at a time", async () => {
  const { core, queue } = makeCore({ admission: null, options: { executionMode: "parallel" } });
  assert.equal(await core.admitNext(), "t1");
  assert.equal(await core.admitNext(), null);
  assert.equal(core.hasLease("t1"), false);
  assert.deepEqual(queue.active, ["t1"]);
});

test("recovered-blocked queues admit only when the caller asks for the recovered head", async () => {
  const { core } = makeCore();
  core.recoveredBlocked = true;
  assert.equal(await core.admitNext(), null);
  assert.equal(await core.admitNext({ recoveredHead: true }), "t1");
});

test("a lease is released when the queue admits a different head than the candidate", async () => {
  const queue = fakeQueue({ pending: ["t1", "t2"] });
  queue.admitNext = async () => "t2";
  const { core, admission } = makeCore({ queue });
  assert.equal(await core.admitNext(), null);
  assert.deepEqual(admission.released, ["lease-1"]);
  assert.equal(core.hasLease("t1"), false);
});

test("a lease is released and the error rethrown when the queue write fails", async () => {
  const queue = fakeQueue({ pending: ["t1"] });
  queue.admitNext = async () => { throw new Error("disk full"); };
  const { core, admission } = makeCore({ queue });
  await assert.rejects(() => core.admitNext(), /disk full/);
  assert.deepEqual(admission.released, ["lease-1"]);
});

test("a second budgeted task waits until the planner memory high-water mark is measured", async () => {
  const queue = fakeQueue({ pending: ["t1", "t2"] });
  const { core, admission } = makeCore({
    queue,
    options: { executionMode: "parallel", parallelTaskReserveBytes: undefined },
  });
  assert.equal(await core.admitNext(), "t1");
  assert.equal(await core.admitNext(), null);
  assert.equal(admission.acquired.length, 1);
});

test("with a measured planner high-water mark the reserve includes it", async () => {
  const queue = fakeQueue({ pending: ["t1", "t2"] });
  const { core, admission } = makeCore({
    queue,
    options: { executionMode: "parallel", parallelTaskReserveBytes: undefined, getExternalProcessHighWaterBytes: () => 100_000_000 },
  });
  assert.equal(await core.admitNext(), "t1");
  assert.equal(await core.admitNext(), "t2");
  assert.equal(admission.acquired[1].reserveBytes, 370_000_000 + 125_000_000);
});

test("releaseLease frees the recorded lease once and is idempotent", async () => {
  const { core, admission } = makeCore();
  await core.admitNext();
  await core.releaseLease("t1");
  await core.releaseLease("t1");
  assert.deepEqual(admission.released, ["lease-1"]);
  assert.equal(core.hasLease("t1"), false);
});

test("concurrent admitNext calls are serialised and never exceed the cap", async () => {
  const { core, queue } = makeCore({ options: { executionMode: "parallel", maxParallelTasks: 2 } });
  const results = await Promise.all([core.admitNext(), core.admitNext(), core.admitNext()]);
  assert.deepEqual(results.filter(Boolean).sort(), ["t1", "t2"]);
  assert.equal(queue.active.length, 2);
});
