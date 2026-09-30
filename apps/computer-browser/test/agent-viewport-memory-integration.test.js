"use strict";

// Real-Electron end-to-end evidence for the P0 agent-viewport memory/latency
// acceptance gate (see integration/agent-viewport-memory-electron.js's own
// header for what this specifically proves and what it deliberately does
// NOT re-prove). Same orchestration-only pattern as
// test/long-horizon-integration.test.js: spawn the real `electron` binary
// against the real script, parse the RESULT_JSON line it prints, and assert
// on the real measurements -- never run via node --test's in-process body,
// and skipped (not silently passed) if Electron cannot actually launch here.

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { createElectronTestProfile } = require("./electron-test-profile");

const APP_ROOT = path.resolve(__dirname, "..");
const ELECTRON_BIN = path.join(APP_ROOT, "node_modules", ".bin", "electron");
const SCRIPT = path.join(APP_ROOT, "integration", "agent-viewport-memory-electron.js");

function runElectronIntegration({ timeoutMs, profile }) {
  return new Promise((resolve, reject) => {
    const child = spawn(ELECTRON_BIN, profile.argsFor(SCRIPT), {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        HALO_PYTHON: process.env.HALO_PYTHON || path.join(APP_ROOT, "..", "..", ".venv", "bin", "python"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`agent-viewport-memory-electron.js did not finish within ${timeoutMs}ms\nstderr tail:\n${stderr.slice(-4000)}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const line = stdout.split("\n").find((l) => l.startsWith("RESULT_JSON:"));
      if (!line) {
        reject(new Error(`no RESULT_JSON line in stdout (exit code ${code})\nstdout:\n${stdout}\nstderr tail:\n${stderr.slice(-4000)}`));
        return;
      }
      try {
        resolve(JSON.parse(line.slice("RESULT_JSON:".length)));
      } catch (err) {
        reject(new Error(`RESULT_JSON did not parse as JSON: ${err.message}\nline: ${line}`));
      }
    });
  });
}

test(
  "real Electron + real AgentViewportHost + real approver/planner: same-journey memory/latency, cold/warm, cross-task isolation, real crash recovery",
  { timeout: 180000 },
  async (t) => {
    const profile = await createElectronTestProfile();
    t.after(() => profile.cleanup());
    let result;
    try {
      result = await runElectronIntegration({ timeoutMs: 170000, profile });
    } catch (err) {
      if (/ENOENT|spawn.*electron/i.test(String(err.message))) {
        t.skip(`electron binary unavailable in this environment: ${err.message}`);
        return;
      }
      throw err;
    }

    if (result.error) {
      throw new Error(`agent-viewport-memory-electron.js reported an internal error: ${result.error}`);
    }

    assert.equal(result.real, true, "this must be the real-Electron run, not a stand-in");

    // --- Peak aggregate memory: the actual <1GB requirement, over BOTH
    // tasks' hidden agent renderers plus planner/approver. ---
    assert.deepEqual(result.memory.unmeasurable, [], "every live Electron/approver/planner process must be measurable");
    assert.ok(result.memory.sampleCount > 0, "must have taken at least one real memory sample");
    assert.equal(
      result.memory.pass,
      true,
      `real peak memory ${result.memory.peakBytes} bytes exceeded the ${result.memory.limitBytes}-byte cap`,
    );

    // --- Cold vs warm: the hidden agent renderer's own first navigation vs
    // its steady state after several more real page loads across context
    // resets, for the SAME task/renderer. ---
    assert.ok(Number.isFinite(result.coldWarm.task1ColdStartBytes) && result.coldWarm.task1ColdStartBytes > 0);
    assert.ok(Number.isFinite(result.coldWarm.task1WarmSteadyBytes) && result.coldWarm.task1WarmSteadyBytes > 0);
    assert.ok(Number.isFinite(result.coldWarm.task2ColdStartBytes) && result.coldWarm.task2ColdStartBytes > 0);

    // --- Cross-task isolation: task 2's fresh renderer must not still see
    // task 1's already-disposed agent/visible pids. ---
    assert.equal(
      result.crossTaskIsolation.pass,
      true,
      `stale task-1 pids leaked into task 2's sample: ${JSON.stringify(result.crossTaskIsolation.staleTask1PidsAtTask2ColdStart)}`,
    );

    // --- Failure/recovery: a genuine renderer crash against the hidden
    // agent view must be memory-reclaimed and dispose()-safe. ---
    assert.equal(result.failureRecovery.pidGoneAfterCrash, true, "the crashed agent renderer's pid must disappear from app.getAppMetrics()");
    assert.equal(result.failureRecovery.disposeAfterCrashThrew, false, "AgentViewportHost.dispose() must tolerate a genuinely crashed webContents");
    assert.equal(result.failureRecovery.hasViewAfterDisposeAfterCrash, false);
    assert.equal(result.failureRecovery.hasViewAfterTask2Dispose, false);
    assert.equal(result.failureRecovery.pass, true, `failure/recovery checks did not all pass: ${JSON.stringify(result.failureRecovery)}`);

    // --- Latency: p50/p95 for every real round trip must be reported. ---
    for (const label of ["browser_observe", "browser_execute", "durable_store", "planner_roundtrip", "approver_roundtrip"]) {
      assert.ok(result.latency[label], `missing latency stats for ${label}`);
      assert.ok(result.latency[label].count > 0, `${label} must have at least one real sample`);
    }

    t.diagnostic(`peak memory: ${result.memory.peakBytes} bytes (limit ${result.memory.limitBytes}); wall time ${result.wallMs}ms`);
    t.diagnostic(`coldWarm: ${JSON.stringify(result.coldWarm)}`);
    t.diagnostic(`crossTaskIsolation: ${JSON.stringify(result.crossTaskIsolation)}`);
    t.diagnostic(`failureRecovery: ${JSON.stringify(result.failureRecovery)}`);
    t.diagnostic(`latency: ${JSON.stringify(result.latency)}`);
  },
);
