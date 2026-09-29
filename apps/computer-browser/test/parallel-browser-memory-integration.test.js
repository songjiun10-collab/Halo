"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawn } = require("node:child_process");

const APP_ROOT = path.resolve(__dirname, "..");
const ELECTRON_BIN = path.join(APP_ROOT, "node_modules", ".bin", "electron");
const SCRIPT = path.join(APP_ROOT, "integration", "parallel-browser-memory-electron.js");

test("real Electron concurrent visible+hidden task surfaces are measured against the 1GB cap", { timeout: 90000 }, async (t) => {
  const result = await new Promise((resolve, reject) => {
    const child = spawn(ELECTRON_BIN, [SCRIPT], { cwd: APP_ROOT, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`parallel memory probe timed out\n${stderr.slice(-3000)}`)); }, 80000);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const line = stdout.split("\n").find((item) => item.startsWith("RESULT_JSON:"));
      if (!line) return reject(new Error(`missing RESULT_JSON (exit ${code})\n${stderr.slice(-3000)}`));
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
  assert.equal(result.pass, true, `concurrent peak ${result.peakBytes} exceeds ${result.limitBytes} or is unmeasurable`);
  assert.equal(result.unmeasurable.length, 0);
  assert.ok(result.sampleCount >= 20);
  assert.ok(result.reservedPerTaskSuggestionBytes > 0);
  assert.match(result.limitation, /no planner or approver workers/);
});
