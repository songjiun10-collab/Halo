"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const os = require("node:os");
const fs = require("node:fs");

const APP_ROOT = path.resolve(__dirname, "..");
const CHROMIUM = [process.env.HALO_CHROMIUM, path.join(os.homedir(), "chromium/src/out/TrialLean/headless_shell")].find((candidate) => candidate && fs.existsSync(candidate));
const SCRIPT = path.join(APP_ROOT, "integration", "backend-controls-chromium.js");

test("real Chromium runtime verifies backend controls plus resource-gated parallel planner and approver execution", { timeout: 150000, skip: !CHROMIUM && "no Chromium binary" }, async (t) => {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], { cwd: APP_ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HALO_DESKTOP_RUNTIME: "chromium", HALO_CHROMIUM: CHROMIUM, HALO_PYTHON: process.env.HALO_PYTHON || path.join(APP_ROOT, "..", "..", ".venv", "bin", "python") } });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`backend control integration timed out\n${stderr.slice(-4000)}`)); }, 140000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const line = stdout.split("\n").find((item) => item.startsWith("RESULT_JSON:"));
      if (!line) return reject(new Error(`missing RESULT_JSON (exit ${code})\n${stderr.slice(-4000)}`));
      try { resolve(JSON.parse(line.slice("RESULT_JSON:".length))); }
      catch (error) { reject(new Error(`invalid result JSON: ${error.message}`)); }
    });
  }).catch((error) => {
    if (/ENOENT/i.test(String(error.message))) { t.skip(`runtime unavailable: ${error.message}`); return null; }
    throw error;
  });
  if (!result) return;
  if (result.error) throw new Error(result.error);
  assert.equal(result.real, true);
  assert.equal(result.permission.observeDenied, true);
  assert.equal(result.permission.browseNavigated, true);
  assert.equal(result.credential.autofillSucceeded, true);
  assert.equal(result.credential.noSecretInJournal, true);
  assert.equal(result.memory.automaticUntrustedContext, true);
  assert.equal(result.queue.recoveredFifo, true);
  assert.equal(result.queue.noEagerBrowserAttach, true);
  assert.equal(result.parallel.twoTaskHostAdmission, true);
  assert.equal(result.parallel.bothHumanApprovalsReleased, true);
  assert.equal(result.parallel.realActionsDispatched, true);
  assert.equal(result.parallel.workersMeasured, true);
  assert.ok(result.parallel.aggregatePeakBytes < result.parallel.limitBytes);
  t.diagnostic(JSON.stringify(result));
});
