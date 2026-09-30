"use strict";

// Regression cover for the 2026-09-27 approver_error root-cause fixes
// (ECONNREFUSED retry, follow_link/scroll/observe approver vocabulary,
// buildObserveScript() text extraction): spawns
// integration/repeat-journey-verification.js as a real child process, which
// drives several REAL, independent 3-page journeys (navigate -> follow_link
// -> follow_link -> finish) against one real Electron app + one real Python
// approver process, and asserts every one of them actually completed. A
// smaller iteration count than the manual 20-run verification (see
// docs/reviews/REPORT_REMEDIATION.ko.md, 후속 22, for that full run's
// numbers) -- this file's job is routine regression cover, not the
// soak-test itself.
//
// Same environment requirements and skip discipline as
// long-horizon-integration.test.js: a real `electron` binary and a real
// Python interpreter with this repo's venv. A skip here must never be read
// as "verified".

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { createElectronTestProfile } = require("./electron-test-profile");

const APP_ROOT = path.resolve(__dirname, "..");
const ELECTRON_BIN = path.join(APP_ROOT, "node_modules", ".bin", "electron");
const SCRIPT = path.join(APP_ROOT, "integration", "repeat-journey-verification.js");
const REPEAT_COUNT = 5;

function runRepeatVerification({ storageRoot, timeoutMs, profile }) {
  return new Promise((resolve, reject) => {
    const child = spawn(ELECTRON_BIN, profile.argsFor(SCRIPT), {
      cwd: APP_ROOT,
      env: {
        ...process.env,
        HALO_PYTHON: process.env.HALO_PYTHON || path.join(APP_ROOT, "..", "..", ".venv", "bin", "python"),
        HALO_TEST_STORAGE_ROOT: storageRoot,
        HALO_REPEAT_COUNT: String(REPEAT_COUNT),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`repeat-journey-verification.js did not finish within ${timeoutMs}ms\nstderr tail:\n${stderr.slice(-4000)}`));
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
    child.on("exit", () => {
      clearTimeout(timer);
      const line = stdout.split("\n").find((l) => l.startsWith("RESULT_JSON:"));
      if (!line) {
        reject(new Error(`no RESULT_JSON line in stdout\nstdout:\n${stdout}\nstderr tail:\n${stderr.slice(-4000)}`));
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
  `real Electron + real Python approver: ${REPEAT_COUNT} consecutive independent 3-page journeys all complete`,
  { timeout: 60000 },
  async (t) => {
    const profile = await createElectronTestProfile();
    t.after(() => profile.cleanup());
    let storageRoot;
    try {
      storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-repeat-integration-"));
    } catch (err) {
      t.skip(`could not create a temp storage root: ${err.message}`);
      return;
    }

    let result;
    try {
      result = await runRepeatVerification({ storageRoot, timeoutMs: 50000, profile });
    } catch (err) {
      if (/ENOENT|spawn.*electron/i.test(String(err.message))) {
        t.skip(`electron binary unavailable in this environment: ${err.message}`);
        return;
      }
      throw err;
    }

    if (result.error) {
      throw new Error(`repeat-journey-verification.js reported an internal error: ${result.error}`);
    }

    assert.equal(result.real, true);
    assert.equal(result.iterations, REPEAT_COUNT);

    for (const iter of result.perIteration) {
      assert.equal(
        iter.success,
        true,
        `iteration ${iter.iteration} did not complete: finalState=${iter.finalState} pauseReason=${iter.pauseReason} error=${iter.error} paths=${JSON.stringify(iter.newRequestPaths)}`,
      );
      assert.deepEqual(iter.newRequestPaths, ["/", "/page2", "/page3"], `iteration ${iter.iteration} must request each fixture page exactly once, in order`);
    }
    assert.equal(result.successCount, REPEAT_COUNT);
    assert.equal(result.failureCount, 0);

    assert.equal(
      result.memory.pass,
      true,
      `real peak memory ${result.memory.peakBytes} bytes exceeded the ${result.memory.limitBytes}-byte cap`,
    );
    assert.ok(result.memory.sampleCount > 0, "must have taken at least one real memory sample across the whole run");

    t.diagnostic(
      `${result.successCount}/${result.iterations} succeeded; elapsed min/mean/max = ${result.elapsed.minMs}/${Math.round(result.elapsed.meanMs)}/${result.elapsed.maxMs}ms; peak memory ${result.memory.peakBytes} bytes (${result.memory.sampleCount} samples @ ${result.samplingIntervalMs}ms); total wall ${result.totalWallMs}ms`,
    );
  },
);
