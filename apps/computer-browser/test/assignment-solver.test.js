"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { solveAssignment, checkAssignment } = require("../main/harness/assignment-solver");
const { HostSettingsStore } = require("../main/harness/host-settings");

const problem = {
  objects: { a: 10, b: 10, c: 10, d: 10 },
  containers: { host0: 20, host1: 20 },
  current: { a: "host0", b: "host0", c: "host0", d: "host1" },
};

test("the default mode packs objects first-fit-decreasing and never exceeds a capacity", async () => {
  const result = await solveAssignment({ ...problem, mode: "greedy" });
  assert.equal(result.status, "ok");
  assert.equal(result.via, "greedy");
  assert.deepEqual(checkAssignment(problem, result.assignment), { ok: true });
  assert.deepEqual(await solveAssignment({ ...problem, mode: "greedy" }), result, "same input, same answer");
});

test("what does not fit is reported as unassigned, never forced into a container", async () => {
  const result = await solveAssignment({ objects: { big: 30, small: 5 }, containers: { host0: 20 }, mode: "greedy" });
  assert.deepEqual(result.assignment, { small: "host0" });
  assert.deepEqual(result.unassigned, ["big"]);
});

test("an assignment is checked independently: unknown container, missing object and overload all fail", () => {
  assert.equal(checkAssignment(problem, { a: "host0", b: "host0", c: "host1", d: "host1" }).ok, true);
  assert.equal(checkAssignment(problem, { a: "host0", b: "host0", c: "host0", d: "host1" }).ok, false, "30 in a 20 container");
  assert.equal(checkAssignment(problem, { a: "nope", b: "host0", c: "host1", d: "host1" }).ok, false);
  assert.equal(checkAssignment(problem, { a: "host0" }).ok, false, "d is not placed");
});

function stubRebalancer(dir, body) {
  fs.mkdirSync(path.join(dir, "rebalancer"), { recursive: true });
  fs.writeFileSync(path.join(dir, "rebalancer", "__init__.py"), body);
}

test("rebalancer mode asks the Python library through the bridge and uses its answer when it checks out", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "halo-rb-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  // A stand-in with the shape of the documented API: it records nothing and answers with a fixed 2-2 split.
  stubRebalancer(dir, `
class ProblemSolver:
    def __init__(self, **kw): self.assignment = None
    def __getattr__(self, name):
        def chain(*a, **k):
            if name == "set_assignment": self.assignment = a[0]
            return self
        return chain
    def solve(self):
        return {"assignment": {"a": "host1", "b": "host0", "c": "host1", "d": "host0"}}
`);
  fs.writeFileSync(path.join(dir, "rebalancer", "specs.py"), ["ConstraintSpec", "CapacitySpec", "LocalSearchSolverSpec", "MoveTypeSpec", "SingleMoveTypeSpec", "SwapMoveTypeSpec", "SolverSpec"].map((n) => `class ${n}:\n    def __init__(self, *a, **k): pass\n`).join("\n"));
  const result = await solveAssignment({ ...problem, mode: "rebalancer", env: { PYTHONPATH: dir } });
  assert.equal(result.status, "ok");
  assert.equal(result.via, "rebalancer");
  assert.deepEqual(result.assignment, { a: "host1", b: "host0", c: "host1", d: "host0" });
});

test("when Rebalancer is not installed, the answer is the greedy one and says so", async () => {
  const result = await solveAssignment({ ...problem, mode: "rebalancer", env: { PYTHONPATH: "/nonexistent" }, pythonCommand: process.env.HALO_PYTHON || "python3" });
  assert.equal(result.status, "ok");
  assert.equal(result.via, "greedy_fallback");
  assert.equal(result.fallbackReason, "rebalancer_not_installed");
  assert.deepEqual(checkAssignment(problem, result.assignment), { ok: true });
});

test("a Rebalancer answer that breaks a capacity is rejected, not trusted", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "halo-rb-bad-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  stubRebalancer(dir, `
class ProblemSolver:
    def __init__(self, **kw): pass
    def __getattr__(self, name):
        return lambda *a, **k: self
    def solve(self):
        return {"assignment": {"a": "host0", "b": "host0", "c": "host0", "d": "host0"}}
`);
  fs.writeFileSync(path.join(dir, "rebalancer", "specs.py"), ["ConstraintSpec", "CapacitySpec", "LocalSearchSolverSpec", "MoveTypeSpec", "SingleMoveTypeSpec", "SwapMoveTypeSpec", "SolverSpec"].map((n) => `class ${n}:\n    def __init__(self, *a, **k): pass\n`).join("\n"));
  const result = await solveAssignment({ ...problem, mode: "rebalancer", env: { PYTHONPATH: dir } });
  assert.equal(result.via, "greedy_fallback");
  assert.equal(result.fallbackReason, "rebalancer_answer_invalid");
});

test("a Rebalancer run that hangs is cut off at the timeout and falls back", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "halo-rb-hang-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  stubRebalancer(dir, `
import time
class ProblemSolver:
    def __init__(self, **kw): pass
    def __getattr__(self, name):
        return lambda *a, **k: self
    def solve(self):
        time.sleep(30)
`);
  fs.writeFileSync(path.join(dir, "rebalancer", "specs.py"), ["ConstraintSpec", "CapacitySpec", "LocalSearchSolverSpec", "MoveTypeSpec", "SingleMoveTypeSpec", "SwapMoveTypeSpec", "SolverSpec"].map((n) => `class ${n}:\n    def __init__(self, *a, **k): pass\n`).join("\n"));
  const started = Date.now();
  const result = await solveAssignment({ ...problem, mode: "rebalancer", env: { PYTHONPATH: dir }, timeoutMs: 800 });
  assert.equal(result.fallbackReason, "rebalancer_timeout");
  assert.ok(Date.now() - started < 5000);
});

test("malformed problems are refused before anything runs", async () => {
  for (const bad of [{}, { objects: [], containers: {} }, { objects: { a: -1 }, containers: { h: 1 } }, { objects: { a: "x" }, containers: { h: 1 } }, { objects: { a: 1 }, containers: {} }]) {
    await assert.rejects(solveAssignment({ ...bad, mode: "greedy" }), /invalid_problem/);
  }
  await assert.rejects(solveAssignment({ ...problem, mode: "magic" }), /invalid_mode/);
});

test("the solver mode is a host setting: greedy by default, rebalancer only when chosen, nothing else accepted", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "halo-settings-solver-"));
  try {
    const store = new HostSettingsStore({ storageRoot: dir });
    assert.equal((await store.load()).assignmentSolver, undefined, "unset means greedy");
    assert.equal((await store.update({ assignmentSolver: "rebalancer" })).assignmentSolver, "rebalancer");
    assert.equal((await store.update({ assignmentSolver: "greedy" })).assignmentSolver, "greedy");
    await assert.rejects(store.update({ assignmentSolver: "magic" }), /assignmentSolver/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
