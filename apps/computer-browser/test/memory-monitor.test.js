"use strict";

// Tests for main/harness/memory-monitor.js (design doc section 10): sums
// Electron-tracked process memory (app.getAppMetrics(), KB per Electron's
// documented MemoryInfo structure) with OS-level memory for registered
// external processes (the Python approver, a local planner worker),
// deduplicated by (pid, creationTime), and reports a three-tier pressure
// level (caution/pause/emergency at 70/80/90% of a <=1GB cap). Both
// getAppMetrics and the external-process memory lookup are injected so this
// runs with no real Electron and no real child processes.

const test = require("node:test");
const assert = require("node:assert/strict");
const { MemoryMonitor, MemoryMonitorError } = require("../main/harness/memory-monitor");

function mb(n) {
  return n * 1_000_000; // decimal MB, matching the user's "conservative decimal GB" mandate
}

test("sums Electron-tracked process memory (KB -> bytes) across main/renderer/gpu/utility", async () => {
  const monitor = new MemoryMonitor({
    getAppMetrics: () => [
      { pid: 1, type: "Browser", memory: { workingSetSize: 100_000 } }, // KB
      { pid: 2, type: "Renderer", memory: { workingSetSize: 50_000 } },
      { pid: 3, type: "GPU", memory: { workingSetSize: 30_000 } },
      { pid: 4, type: "Utility", memory: { workingSetSize: 20_000 } },
    ],
  });

  const result = await monitor.sample();

  assert.equal(result.totalBytes, (100_000 + 50_000 + 30_000 + 20_000) * 1024);
  assert.deepEqual(result.unmeasurable, []);
});

test("adds registered external process memory (Python approver, local worker) to the total", async () => {
  const monitor = new MemoryMonitor({
    getAppMetrics: () => [{ pid: 1, type: "Browser", memory: { workingSetSize: 100_000 } }],
    getExternalMemoryBytes: async (pid) => (pid === 555 ? mb(40) : null),
  });
  monitor.registerExternalProcess({ pid: 555, creationTime: 1000, label: "approver" });

  const result = await monitor.sample();

  assert.equal(result.totalBytes, 100_000 * 1024 + mb(40));
});

test("unregister() stops counting a previously-registered external process", async () => {
  const monitor = new MemoryMonitor({
    getAppMetrics: () => [],
    getExternalMemoryBytes: async () => mb(40),
  });
  monitor.registerExternalProcess({ pid: 555, creationTime: 1000, label: "approver" });
  monitor.unregister(555);

  const result = await monitor.sample();

  assert.equal(result.totalBytes, 0);
});

test("unregister(pid, creationTime) does not remove a newer process that reused the pid", async () => {
  const monitor = new MemoryMonitor({
    getAppMetrics: () => [],
    getExternalMemoryBytes: async () => mb(12),
  });
  monitor.registerExternalProcess({ pid: 555, creationTime: 2000, label: "new-planner" });

  monitor.unregister(555, 1000); // late exit callback from the old process

  const result = await monitor.sample();
  assert.equal(result.totalBytes, mb(12));
  assert.equal(result.byProcess[0].label, "external:new-planner");
});

// --- Dedup by (pid, creationTime): a recycled pid that Electron itself now
// also reports must not be double-counted or misattributed.

test("dedupes by (pid, creationTime) so a recycled pid is never double-counted", async () => {
  const monitor = new MemoryMonitor({
    getAppMetrics: () => [{ pid: 555, type: "Utility", memory: { workingSetSize: 10_000 }, creationTime: 1000 }],
    getExternalMemoryBytes: async () => mb(999), // would wildly over-count if also summed
  });
  monitor.registerExternalProcess({ pid: 555, creationTime: 1000, label: "approver" });

  const result = await monitor.sample();

  assert.equal(result.totalBytes, 10_000 * 1024, "the Electron-reported entry for the same (pid, creationTime) must win, not be added twice");
});

test("a registered external process with a DIFFERENT creationTime from a same-pid Electron entry is counted separately (no misattribution)", async () => {
  const monitor = new MemoryMonitor({
    getAppMetrics: () => [{ pid: 555, type: "Utility", memory: { workingSetSize: 10_000 }, creationTime: 1000 }],
    getExternalMemoryBytes: async () => mb(40),
  });
  // A stale registration for a pid that Electron has since recycled under a
  // new creationTime -- these must not be merged into one.
  monitor.registerExternalProcess({ pid: 555, creationTime: 999, label: "approver" });

  const result = await monitor.sample();

  assert.equal(result.totalBytes, 10_000 * 1024 + mb(40));
});

// --- Unsupported/unmeasurable metrics must never be silently treated as 0.

test("reports a process as unmeasurable (not 0) when Electron's memory field is missing", async () => {
  const monitor = new MemoryMonitor({
    getAppMetrics: () => [
      { pid: 1, type: "Browser", memory: { workingSetSize: 100_000 } },
      { pid: 2, type: "Renderer", memory: {} }, // e.g. an unsupported platform metric
    ],
  });

  const result = await monitor.sample();

  assert.equal(result.totalBytes, 100_000 * 1024, "an unmeasurable process must not silently contribute 0 to the sum");
  assert.ok(result.unmeasurable.some((entry) => entry.includes("2")), "pid 2 must be listed as unmeasurable");
});

test("reports a registered external process as unmeasurable when its lookup fails", async () => {
  const monitor = new MemoryMonitor({
    getAppMetrics: () => [],
    getExternalMemoryBytes: async () => null,
  });
  monitor.registerExternalProcess({ pid: 777, creationTime: 1, label: "worker" });

  const result = await monitor.sample();

  assert.equal(result.totalBytes, 0);
  assert.ok(result.unmeasurable.some((entry) => entry.includes("worker")));
});

test("reports a registered external process as unmeasurable when its lookup throws (e.g. the process already exited)", async () => {
  const monitor = new MemoryMonitor({
    getAppMetrics: () => [],
    getExternalMemoryBytes: async () => {
      throw new Error("ESRCH");
    },
  });
  monitor.registerExternalProcess({ pid: 777, creationTime: 1, label: "worker" });

  const result = await monitor.sample();

  assert.equal(result.totalBytes, 0);
  assert.ok(result.unmeasurable.some((entry) => entry.includes("worker")));
});

test("does not report a planner as unmeasurable if it exited while an in-flight RSS lookup was pending", async () => {
  let monitor;
  monitor = new MemoryMonitor({
    getAppMetrics: () => [],
    getExternalMemoryBytes: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      monitor.unregister(777);
      return null;
    },
  });
  monitor.registerExternalProcess({ pid: 777, creationTime: 1, label: "planner" });

  const result = await monitor.sample();

  assert.equal(result.totalBytes, 0);
  assert.deepEqual(result.unmeasurable, [], "the worker is no longer alive at sample completion and must not poison current live-process completeness");
  assert.deepEqual(result.byProcess, []);
});

test("does not attribute a successful stale RSS lookup after the registered process exits", async () => {
  let monitor;
  monitor = new MemoryMonitor({
    getAppMetrics: () => [],
    getExternalMemoryBytes: async () => {
      await new Promise((resolve) => setImmediate(resolve));
      monitor.unregister(778, 10);
      return mb(450);
    },
  });
  monitor.registerExternalProcess({ pid: 778, creationTime: 10, label: "planner" });

  const result = await monitor.sample();

  assert.equal(result.totalBytes, 0, "RSS from a no-longer-registered process must not affect the cap");
  assert.deepEqual(result.unmeasurable, []);
  assert.deepEqual(result.byProcess, []);
});

// --- Three-tier pressure level at 70/80/90% of the (<=1GB) cap.

test("getPressureLevel reports normal/caution/pause/emergency at the right thresholds of the default 1GB cap", async () => {
  let total = 0;
  const monitor = new MemoryMonitor({ getAppMetrics: () => [{ pid: 1, type: "Browser", memory: { workingSetSize: total / 1024 } }] });

  total = mb(699);
  await monitor.sample();
  assert.equal(monitor.getPressureLevel(), "normal");

  total = mb(701);
  await monitor.sample();
  assert.equal(monitor.getPressureLevel(), "caution");

  total = mb(801);
  await monitor.sample();
  assert.equal(monitor.getPressureLevel(), "pause");

  total = mb(901);
  await monitor.sample();
  assert.equal(monitor.getPressureLevel(), "emergency");
});

test("getPressureLevel before any sample() call is 'normal' (no false pressure from an empty reading)", () => {
  const monitor = new MemoryMonitor({ getAppMetrics: () => [] });
  assert.equal(monitor.getPressureLevel(), "normal");
});

// --- Thresholds scale with a lower user-configured cap, but the cap itself
// can never be raised above 1GB (design doc section 10, user mandate: "사용자
// 한도 자체를 높이지 마세요").

test("a lower configured limitBytes scales the 70/80/90% thresholds down with it", async () => {
  let total = 0;
  const monitor = new MemoryMonitor({
    getAppMetrics: () => [{ pid: 1, type: "Browser", memory: { workingSetSize: total / 1024 } }],
    limitBytes: mb(500),
  });

  total = mb(351); // just over 70% of 500MB
  await monitor.sample();
  assert.equal(monitor.getPressureLevel(), "caution");
});

test("constructing with limitBytes above 1,000,000,000 is rejected outright", () => {
  assert.throws(
    () => new MemoryMonitor({ getAppMetrics: () => [], limitBytes: 1_000_000_001 }),
    MemoryMonitorError,
  );
});

test("setLimitBytes() also rejects raising the cap above 1,000,000,000", () => {
  const monitor = new MemoryMonitor({ getAppMetrics: () => [] });
  assert.throws(() => monitor.setLimitBytes(2_000_000_000), MemoryMonitorError);
  // Lowering it further is fine.
  monitor.setLimitBytes(mb(500));
});

// --- registerExternalProcess/unregister input validation.

test("registerExternalProcess requires pid, creationTime, and label", () => {
  const monitor = new MemoryMonitor({ getAppMetrics: () => [] });
  assert.throws(() => monitor.registerExternalProcess({ pid: 1, creationTime: 1 }), MemoryMonitorError);
  assert.throws(() => monitor.registerExternalProcess({ pid: 1, label: "x" }), MemoryMonitorError);
  assert.throws(() => monitor.registerExternalProcess({ creationTime: 1, label: "x" }), MemoryMonitorError);
});
