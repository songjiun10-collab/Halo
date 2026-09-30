"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createElectronTestProfile } = require("./electron-test-profile");

const APP_ROOT = path.resolve(__dirname, "..");
const ELECTRON_BIN = path.join(APP_ROOT, "node_modules", ".bin", "electron");
const SCRIPT = path.join(APP_ROOT, "integration", "backend-controls-electron.js");

test("real Electron verifies backend controls plus resource-gated parallel planner and approver execution", { timeout: 90000 }, async (t) => {
  const profile = await createElectronTestProfile();
  t.after(() => profile.cleanup());
  const result = await new Promise((resolve, reject) => {
    const child = spawn(ELECTRON_BIN, profile.argsFor(SCRIPT), { cwd: APP_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`backend control integration timed out\n${stderr.slice(-4000)}`)); }, 80000);
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
    if (/ENOENT|spawn.*electron/i.test(String(error.message))) { t.skip(`Electron unavailable: ${error.message}`); return null; }
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
