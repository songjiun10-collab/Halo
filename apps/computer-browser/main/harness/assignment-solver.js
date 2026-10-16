"use strict";

// "Which object goes in which container" under capacities, as a separate, opt-in mode.
//   greedy (default)  first-fit-decreasing, in this process, always available.
//   rebalancer        asks facebook/rebalancer (a Python/C++ solver the person installs themselves) through
//                     rebalancer-bridge.py. Its answer is checked here before it is used; if the library is
//                     missing, fails, hangs or answers wrongly, the greedy answer is returned and says why.
// Nothing in HALO's task admission calls this yet (admission is first-come, first-served); it is the mode and
// the safety net, ready for a caller that has a real assignment to make.

const { spawn } = require("node:child_process");
const path = require("node:path");

const MODES = Object.freeze(["greedy", "rebalancer"]);
const MAX_ENTRIES = 5000;
const DEFAULT_TIMEOUT_MS = 30_000;
const BRIDGE = path.join(__dirname, "rebalancer-bridge.py");

class AssignmentSolverError extends Error {
  constructor(code, message) { super(`${code}: ${message}`); this.name = "AssignmentSolverError"; this.code = code; }
}

const isNumberMap = (value) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length > 0 && Object.keys(value).length <= MAX_ENTRIES &&
  Object.values(value).every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0);

function validateProblem(problem) {
  if (!problem || !isNumberMap(problem.objects) || !isNumberMap(problem.containers)) {
    throw new AssignmentSolverError("invalid_problem", "objects and containers must be non-empty maps of non-negative numbers");
  }
  if (problem.current !== undefined && (problem.current === null || typeof problem.current !== "object" || Array.isArray(problem.current))) {
    throw new AssignmentSolverError("invalid_problem", "current must be a map of object to container");
  }
}

/** Independent check of any answer: every object placed once, in a known container, no capacity exceeded. */
function checkAssignment(problem, assignment) {
  if (!assignment || typeof assignment !== "object") return { ok: false, reason: "no_assignment" };
  const used = Object.fromEntries(Object.keys(problem.containers).map((name) => [name, 0]));
  for (const object of Object.keys(problem.objects)) {
    const container = assignment[object];
    if (typeof container !== "string" || !Object.hasOwn(used, container)) return { ok: false, reason: `object_unplaced:${object}` };
    used[container] += problem.objects[object];
  }
  for (const name of Object.keys(used)) if (used[name] > problem.containers[name]) return { ok: false, reason: `over_capacity:${name}` };
  if (Object.keys(assignment).some((object) => !Object.hasOwn(problem.objects, object))) return { ok: false, reason: "unknown_object" };
  return { ok: true };
}

function greedy(problem) {
  const free = { ...problem.containers };
  const assignment = {};
  const unassigned = [];
  const order = Object.keys(problem.objects).sort((a, b) => problem.objects[b] - problem.objects[a] || (a < b ? -1 : 1));
  const containers = Object.keys(problem.containers).sort();
  for (const object of order) {
    const home = containers.find((name) => free[name] >= problem.objects[object]);
    if (home === undefined) { unassigned.push(object); continue; }
    assignment[object] = home;
    free[home] -= problem.objects[object];
  }
  return { status: "ok", via: "greedy", assignment, unassigned: unassigned.sort() };
}

function askBridge(problem, { pythonCommand, env, timeoutMs }) {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const done = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    let child;
    try {
      child = spawn(pythonCommand, [BRIDGE], { stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, ...env } });
    } catch { return resolve({ failure: "rebalancer_bridge_failed" }); }
    const timer = setTimeout(() => { done({ failure: "rebalancer_timeout" }); try { child.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs);
    child.on("error", () => done({ failure: "rebalancer_bridge_failed" }));
    child.stdout.on("data", (chunk) => { out += chunk; if (out.length > 4_000_000) { done({ failure: "rebalancer_answer_invalid" }); try { child.kill("SIGKILL"); } catch { /* gone */ } } });
    child.on("close", () => {
      try {
        const parsed = JSON.parse(out);
        if (parsed?.status === "unavailable") return done({ failure: "rebalancer_not_installed" });
        if (parsed?.status === "ok") return done({ assignment: parsed.assignment });
        return done({ failure: "rebalancer_bridge_failed" });
      } catch { return done({ failure: "rebalancer_bridge_failed" }); }
    });
    child.stdin.on("error", () => { /* the bridge exited early; close reports it */ });
    child.stdin.end(JSON.stringify({ objects: problem.objects, containers: problem.containers, current: problem.current ?? null }));
  });
}

async function solveAssignment({ mode = "greedy", pythonCommand = "python3", env = {}, timeoutMs = DEFAULT_TIMEOUT_MS, ...problem } = {}) {
  if (!MODES.includes(mode)) throw new AssignmentSolverError("invalid_mode", `mode must be one of ${MODES.join(", ")}`);
  validateProblem(problem);
  if (mode === "greedy") return greedy(problem);
  const asked = await askBridge(problem, { pythonCommand, env, timeoutMs });
  if (asked.assignment) {
    if (checkAssignment(problem, asked.assignment).ok) return { status: "ok", via: "rebalancer", assignment: asked.assignment, unassigned: [] };
    return { ...greedy(problem), via: "greedy_fallback", fallbackReason: "rebalancer_answer_invalid" };
  }
  return { ...greedy(problem), via: "greedy_fallback", fallbackReason: asked.failure };
}

module.exports = { solveAssignment, checkAssignment, AssignmentSolverError, MODES };
