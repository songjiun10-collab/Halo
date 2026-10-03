"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { createElectronTestProfile } = require("./electron-test-profile");

test("real Electron refuses local-file and data redirects and preserves an HTTP redirect", { timeout: 30000 }, async (t) => {
  const root = path.resolve(__dirname, "..");
  const profile = await createElectronTestProfile();
  try {
    const { stdout } = await promisify(execFile)(path.join(root, "node_modules/.bin/electron"),
      profile.argsFor(path.join(root, "integration/browser-navigation-electron.js")),
      { cwd: root, timeout: 25000, maxBuffer: 1024 * 1024 });
    const line = stdout.split("\n").find((value) => value.startsWith("RESULT_JSON:"));
    assert.ok(line, "Electron must report its probe results");
    const result = JSON.parse(line.slice("RESULT_JSON:".length));
    assert.equal(result.real, true);
    assert.deepEqual(result.results.map((row) => [row.kind, row.status, row.canaryLoaded]),
      [["file", "failed", false], ["data", "failed", false], ["safe", "ok", false]]);
    t.diagnostic(JSON.stringify(result));
  } finally { await profile.cleanup(); }
});
