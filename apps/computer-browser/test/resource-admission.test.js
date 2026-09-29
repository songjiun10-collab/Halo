"use strict";

// Tests for main/harness/resource-admission.js (multi-agent background
// runtime plan, Task 2): one serialized ledger sitting on top of
// MemoryMonitor so that top-level tasks AND future child agents (Task 3/4)
// can never double-spend the same sampled memory headroom, and so a
// user-confirmed "budgeted" override can bypass admission denial for one
// parent run while telemetry/monitoring stay untouched.

const test = require("node:test");
const assert = require("node:assert/strict");
const { MemoryMonitor } = require("../main/harness/memory-monitor");
const { ResourceAdmission, ResourceAdmissionError } = require("../main/harness/resource-admission");

function mb(n) {
  return n * 1_000_000;
}

function monitorWithFixedTotal({ totalBytes, limitBytes, now = () => 10_000 }) {
  return new MemoryMonitor({
    getAppMetrics: () => [{ pid: 1, type: "Browser", memory: { workingSetSize: totalBytes / 1024 } }],
    limitBytes,
    now,
  });
}

test("acquire() serializes concurrent calls so they cannot double-spend the same sampled headroom", async () => {
  const monitor = monitorWithFixedTotal({ totalBytes: 0, limitBytes: mb(100) });
  await monitor.sample();
  const admission = new ResourceAdmission({ memoryMonitor: monitor });

  const [a, b] = await Promise.all([
    admission.acquire({ ownerId: "task-a", reserveBytes: mb(60) }),
    admission.acquire({ ownerId: "task-b", reserveBytes: mb(60) }),
  ]);

  const results = [a, b];
  const admitted = results.filter((r) => r.admitted);
  const denied = results.filter((r) => !r.admitted);
  assert.equal(admitted.length, 1, "only one of the two 60MB requests fits in a 100MB budget");
  assert.equal(denied.length, 1);
  assert.equal(denied[0].reason, "memory_budget_exceeded");
});

test("acquire() rejects a second lease for an ownerId that already holds one", async () => {
  const monitor = monitorWithFixedTotal({ totalBytes: 0, limitBytes: mb(100) });
  await monitor.sample();
  const admission = new ResourceAdmission({ memoryMonitor: monitor });

  const first = await admission.acquire({ ownerId: "task-a", reserveBytes: mb(10) });
  assert.equal(first.admitted, true);
  const second = await admission.acquire({ ownerId: "task-a", reserveBytes: mb(10) });
  assert.deepEqual(second, { admitted: false, reason: "duplicate_owner" });
});

test("release() is idempotent, including a second release after a caller's own teardown failed and retried", async () => {
  const monitor = monitorWithFixedTotal({ totalBytes: 0, limitBytes: mb(100) });
  await monitor.sample();
  const admission = new ResourceAdmission({ memoryMonitor: monitor });

  const { leaseId } = await admission.acquire({ ownerId: "task-a", reserveBytes: mb(10) });
  await admission.release(leaseId);
  await assert.doesNotReject(admission.release(leaseId), "releasing an already-released lease must not throw");
  await assert.doesNotReject(admission.release("never-issued-lease-id"));

  // The owner slot is freed, so a fresh lease for the same ownerId succeeds.
  const again = await admission.acquire({ ownerId: "task-a", reserveBytes: mb(10) });
  assert.equal(again.admitted, true);
});

test("acquire() denies admission on a stale sample, passing the monitor's reason through", async () => {
  let now = 10_000;
  const monitor = monitorWithFixedTotal({ totalBytes: 0, limitBytes: mb(100), now: () => now });
  await monitor.sample();
  now += 8_000; // past the default 7500ms maxAgeMs
  const admission = new ResourceAdmission({ memoryMonitor: monitor });

  const result = await admission.acquire({ ownerId: "task-a", reserveBytes: mb(10) });
  assert.deepEqual(result, { admitted: false, reason: "memory_sample_stale" });
});

test("acquire() denies admission when the sample is incomplete/unmeasurable", async () => {
  const monitor = new MemoryMonitor({ getAppMetrics: () => [{ pid: 1, type: "Browser", memory: {} }], now: () => 10_000 });
  await monitor.sample();
  const admission = new ResourceAdmission({ memoryMonitor: monitor });

  const result = await admission.acquire({ ownerId: "task-a", reserveBytes: mb(1) });
  assert.deepEqual(result, { admitted: false, reason: "memory_unmeasurable" });
});

test("budgeted mode denies admission under measured memory pressure even when raw headroom math alone would fit", async () => {
  // 85% of a 100MB cap = "pause" tier (>=80%), yet totalBytes + reserveBytes
  // still comes in just under the hard limit -- the plain budget check alone
  // would allow this; the pressure gate must deny it anyway.
  const monitor = monitorWithFixedTotal({ totalBytes: mb(85), limitBytes: mb(100) });
  await monitor.sample();
  assert.equal(monitor.getPressureLevel(), "pause");
  const admission = new ResourceAdmission({ memoryMonitor: monitor });

  const result = await admission.acquire({ ownerId: "task-a", reserveBytes: mb(1) });
  assert.deepEqual(result, { admitted: false, reason: "memory_pressure_pause" });
});

test("a user_override parentPolicy bypasses both the budget check and the pressure-pause gate, and is still tracked in the snapshot", async () => {
  // Deliberately over budget AND at emergency pressure -- budgeted mode
  // would deny this on both grounds.
  const monitor = monitorWithFixedTotal({ totalBytes: mb(99), limitBytes: mb(100) });
  await monitor.sample();
  assert.equal(monitor.getPressureLevel(), "emergency");
  const admission = new ResourceAdmission({ memoryMonitor: monitor });

  const result = await admission.acquire({
    ownerId: "child-1",
    reserveBytes: mb(50),
    parentPolicy: { mode: "user_override", parentTaskId: "parent-1", requestedAgentCount: 2 },
  });
  assert.equal(result.admitted, true);

  const snapshot = admission.getSnapshot();
  assert.equal(snapshot.mode, "user_override");
  assert.deepEqual(snapshot.leases, [{ leaseId: result.leaseId, ownerId: "child-1", reservedBytes: mb(50), mode: "user_override" }]);

  // Monitoring/telemetry are untouched by the override -- the monitor itself
  // still reports the real, unmasked pressure level.
  assert.equal(monitor.getPressureLevel(), "emergency");

  await admission.release(result.leaseId);
  assert.equal(admission.getSnapshot().mode, "budgeted", "the aggregate mode reverts once no override lease remains");
});

test("a just-granted override lease reserves its measured high-water against budgeted work until a newer sample observes it", async () => {
  let now = 10_000;
  let totalBytes = 0;
  const monitor = new MemoryMonitor({
    getAppMetrics: () => [{ pid: 1, type: "Browser", memory: { workingSetSize: totalBytes / 1024 } }],
    limitBytes: mb(100),
    now: () => now,
  });
  await monitor.sample();
  const admission = new ResourceAdmission({ memoryMonitor: monitor, now: () => now });
  const override = await admission.acquire({
    ownerId: "override-parent",
    reserveBytes: mb(60),
    parentPolicy: { mode: "user_override", parentTaskId: "override-parent" },
  });
  assert.equal(override.admitted, true);

  const beforeRefresh = await admission.acquire({ ownerId: "budgeted-parent-before-refresh", reserveBytes: mb(60) });
  assert.deepEqual(beforeRefresh, { admitted: false, reason: "memory_budget_exceeded" });

  // A newer complete sample can retire the reservation padding because its
  // observed total now includes the override task's actual process memory.
  now += 1;
  totalBytes = mb(60);
  await monitor.sample();
  const afterRefresh = await admission.acquire({ ownerId: "budgeted-parent-after-refresh", reserveBytes: mb(30) });
  assert.equal(afterRefresh.admitted, true);
});

test("getSnapshot() reports sampledAt from the monitor and each lease's owner/reservation/mode", async () => {
  const monitor = monitorWithFixedTotal({ totalBytes: 0, limitBytes: mb(100), now: () => 42_000 });
  await monitor.sample();
  const admission = new ResourceAdmission({ memoryMonitor: monitor });
  assert.equal(admission.getSnapshot().sampledAt, 42_000);
  assert.deepEqual(admission.getSnapshot().leases, []);

  const { leaseId } = await admission.acquire({ ownerId: "task-a", reserveBytes: mb(5) });
  assert.deepEqual(admission.getSnapshot().leases, [{ leaseId, ownerId: "task-a", reservedBytes: mb(5), mode: "budgeted" }]);
});

test("acquire() validates ownerId and reserveBytes", async () => {
  const monitor = monitorWithFixedTotal({ totalBytes: 0, limitBytes: mb(100) });
  await monitor.sample();
  const admission = new ResourceAdmission({ memoryMonitor: monitor });

  await assert.rejects(admission.acquire({ reserveBytes: mb(1) }), ResourceAdmissionError);
  await assert.rejects(admission.acquire({ ownerId: "task-a", reserveBytes: -1 }), ResourceAdmissionError);
  await assert.rejects(admission.acquire({ ownerId: "task-a", reserveBytes: "lots" }), ResourceAdmissionError);
});

test("acquire() validates parentPolicy shape", async () => {
  const monitor = monitorWithFixedTotal({ totalBytes: 0, limitBytes: mb(100) });
  await monitor.sample();
  const admission = new ResourceAdmission({ memoryMonitor: monitor });

  await assert.rejects(
    admission.acquire({ ownerId: "task-a", reserveBytes: mb(1), parentPolicy: { mode: "unlimited" } }),
    ResourceAdmissionError,
  );
  await assert.rejects(
    admission.acquire({ ownerId: "task-a", reserveBytes: mb(1), parentPolicy: { mode: "budgeted", requestedAgentCount: 0 } }),
    ResourceAdmissionError,
  );
});

test("constructor requires a memoryMonitor exposing canAdmitTask/getPressureLevel", () => {
  assert.throws(() => new ResourceAdmission({}), ResourceAdmissionError);
  assert.throws(() => new ResourceAdmission({ memoryMonitor: {} }), ResourceAdmissionError);
});
