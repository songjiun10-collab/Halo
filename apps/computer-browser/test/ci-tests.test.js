"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { testFiles, selectFiles } = require("../tools/ci-tests");
const excluded = require("./ci-excluded.json");

test("the CI exclusion list only names real test files and gives each a reason", () => {
  const { problems, files } = selectFiles(testFiles(), excluded);
  assert.deepEqual(problems, []);
  for (const name of Object.keys(excluded)) assert.equal(files.includes(name), false, `${name} is excluded`);
});

test("selectFiles reports a stale or unexplained exclusion instead of ignoring it", () => {
  const all = ["a.test.js", "b.test.js"];
  assert.deepEqual(selectFiles(all, { "a.test.js": "needs the real Electron binary" }).files, ["b.test.js"]);
  assert.match(selectFiles(all, { "gone.test.js": "needs the real Electron binary" }).problems[0], /does not exist/);
  assert.match(selectFiles(all, { "a.test.js": "" }).problems[0], /needs a reason/);
});

test("the safety tests are never in the exclusion list", () => {
  for (const name of Object.keys(excluded)) assert.doesNotMatch(name, /payment|card-blind|pii|privacy|build-expiry|expiry|action-safety|research|host-settings|voice|halo-admin|harness-ipc|task-controller/);
});
