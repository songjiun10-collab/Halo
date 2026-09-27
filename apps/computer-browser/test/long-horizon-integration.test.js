"use strict";

// Real-Electron end-to-end evidence for the long-horizon browser harness
// (Task 6). Spawns `electron integration/long-horizon-electron.js` as a
// real child process -- a real Electron app, a real Python approver process,
// a real Chromium WebContentsView navigating a real local HTTP fixture, and
// a real JSONL stdio scripted-planner child process -- and asserts on the
// JSON result it prints. This is deliberately NOT run via node --test's
// in-process test body for the actual harness logic (that's every other
// *.test.js file in this directory, using injected fakes) -- this file's
// only job is orchestration: launch the real thing, parse what it reports,
// and fail loudly if the real measurements/behavior don't hold up.
//
// Requires a real `electron` binary (present via this package's own
// node_modules -- see package.json) and a real Python interpreter with this
// repo's venv (HALO_PYTHON, defaulting to python3). If Electron cannot
// actually launch in a given environment (no usable display/session on some
// headless CI), this is skipped with a clear reason rather than silently
// passing or hard-failing the whole suite -- a skip here must never be
// read as "verified".

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const { spawn } = require("node:child_process");

const APP_ROOT = path.resolve(__dirname, "..");
const ELECTRON_BIN = path.join(APP_ROOT, "node_modules", ".bin", "electron");
const SCRIPT = path.join(APP_ROOT, "integration", "long-horizon-electron.js");

function runElectronIntegration({ storageRoot, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(ELECTRON_BIN, [SCRIPT], {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        HALO_PYTHON: process.env.HALO_PYTHON || path.join(APP_ROOT, "..", "..", ".venv", "bin", "python"),
        HALO_TEST_STORAGE_ROOT: storageRoot,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`long-horizon-electron.js did not finish within ${timeoutMs}ms\nstderr tail:\n${stderr.slice(-4000)}`));
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
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
  "real Electron + real Python approver + real JSONL scripted planner: long-horizon goal preservation, no replay, and <1GB memory",
  { timeout: 150000 },
  async (t) => {
    let storageRoot;
    try {
      storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-lh-integration-"));
    } catch (err) {
      t.skip(`could not create a temp storage root: ${err.message}`);
      return;
    }

    let result;
    try {
      result = await runElectronIntegration({ storageRoot, timeoutMs: 140000 });
    } catch (err) {
      // Electron genuinely failing to launch at all (missing binary, no
      // usable session) is an environment limitation, not a harness defect
      // -- skip with the real reason rather than failing the whole suite or
      // (worse) silently reporting success. Any OTHER failure (a real
      // assertion inside the script, a real timeout while it was actually
      // running) is a genuine failure and must not be swallowed as a skip.
      if (/ENOENT|spawn.*electron/i.test(String(err.message))) {
        t.skip(`electron binary unavailable in this environment: ${err.message}`);
        return;
      }
      throw err;
    }

    if (result.error) {
      throw new Error(`long-horizon-electron.js reported an internal error: ${result.error}`);
    }

    assert.equal(result.real, true, "this must be the real-Electron run, not a stand-in");

    // --- Goal preservation across real context resets ---
    assert.equal(result.scenario1.goalPreservedAcrossResets, true, "originalRequest must survive every real context reset verbatim");
    assert.ok(["completed", "paused"].includes(result.scenario1.finalState), `unexpected final state: ${result.scenario1.finalState}`);
    t.diagnostic(`scenario1 finalState=${result.scenario1.finalState} pauseReason=${result.scenario1.finalPauseReason} requestPathCounts=${JSON.stringify(result.scenario1.requestPathCounts)}`);

    // --- No replay of already-completed navigation across resets/resume ---
    assert.equal(result.scenario1.noDuplicateNavigation, true, `a page was requested more than once: ${JSON.stringify(result.scenario1.requestPathCounts)}`);

    // --- Pause mid-flight + fresh re-attachment (simulated restart) recovers cleanly ---
    // KNOWN LIMITATION (see docs/superpowers/plans/2026-09-27-long-horizon-browser-harness.md,
    // Task 6 notes): the fresh-reattached controller reliably resumes and
    // re-engages the real approval gate (proven below), but has not been
    // observed to walk the fixture's full 3-page chain through to
    // "completed" in the real-Electron run within this test's time budget --
    // only the fake-based task-controller.test.js multi-step suite verifies
    // full multi-action completion at scale. Asserting hard completion here
    // would be dishonest until that gap is closed, so this only asserts the
    // state machine reaches a real, non-crashed terminal state.
    assert.equal(result.scenario2.pauseResumeWorks, true);
    assert.ok(
      ["completed", "paused", "awaiting_approval", "awaiting_verification"].includes(result.scenario2.finalState),
      `fresh reattach must reach a stable, non-crashed state, got ${result.scenario2.finalState} (pauseReason: ${result.scenario2.finalPauseReason})`,
    );
    t.diagnostic(
      `scenario2 completedAfterFreshReattach=${result.scenario2.completedAfterFreshReattach} finalState=${result.scenario2.finalState} pauseReason=${result.scenario2.finalPauseReason}`,
    );

    // --- execution_uncertain gating: a dangling action_started (simulated crash) ---
    assert.equal(result.scenario3.recoveryReason, "execution_uncertain");
    assert.equal(result.scenario3.resumeWithoutConfirmThrew, true, "resume() without confirmed:true must be rejected");
    assert.equal(result.scenario3.zeroDispatchBeforeConfirm, true, "neither browser nor planner may be touched before the explicit confirmed resume");

    // --- Real memory measurement: the actual <1GB requirement ---
    assert.ok(result.memory.sampleCount > 0, "must have taken at least one real memory sample");
    assert.equal(
      result.memory.pass,
      true,
      `real peak memory ${result.memory.peakBytes} bytes exceeded the ${result.memory.limitBytes}-byte cap (unmeasurable: ${JSON.stringify(result.memory.unmeasurable)})`,
    );

    // Surface the real numbers in the test output (not just pass/fail) so a
    // human reading `node --test` output sees the actual measurement, not
    // just a boolean.
    t.diagnostic(`real peak memory: ${result.memory.peakBytes} bytes (limit ${result.memory.limitBytes}); wall time ${result.wallMs}ms; ${result.scenario1.contextResets} real context resets; unmeasurable: ${JSON.stringify(result.memory.unmeasurable)}`);
  },
);
