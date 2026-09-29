"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { sumProcessTreeRssBytes } = require("../main/harness/process-tree-memory");

test("process tree RSS includes the registered planner wrapper, CLI child and grandchild exactly once", () => {
  const ps = [
    "  PID  PPID   RSS",
    "  100     1 1000",
    "  200   100 2000",
    "  201   200 3000",
    "  300     1 9000",
  ].join("\n");
  assert.equal(sumProcessTreeRssBytes(ps, 100), 6_144_000);
});

test("process tree measurement fails closed when the root is missing or output is unusable", () => {
  assert.equal(sumProcessTreeRssBytes("100 1 123", 999), null);
  assert.equal(sumProcessTreeRssBytes("garbage", 100), null);
  assert.equal(sumProcessTreeRssBytes("100 1 0\n101 100 4", 100), 4096);
});
