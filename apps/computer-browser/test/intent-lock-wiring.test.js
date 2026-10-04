"use strict";

// Intent Lock / Capability Lease wiring across the real composition seams:
// the dual-surface browser the app hands the controller, child agents, and
// the origin a widening grant is bound to inside the BrowserAdapter.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");
const { BrowserAdapter } = require("../main/harness/browser-adapter");
const { makeDualSurfaceBrowser } = require("../main/harness/agent-viewport-host");
const { ChildAgentCoordinator, ChildAgentCoordinatorError } = require("../main/harness/child-agent-coordinator");
const { ResourceAdmission } = require("../main/harness/resource-admission");
const { resolveTaskProfile } = require("../shared/task-profile-router");
const { makeIntentLock } = require("../shared/harness-contracts");

async function mkTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "halo-lock-wiring-"));
}

function fakeWebContents({ loadURL, elements = [] } = {}) {
  const wc = new EventEmitter();
  const loads = [];
  Object.assign(wc, {
    loads,
    getURL: () => "https://github.com/",
    getTitle: () => "",
    close() {},
    stop() {},
    loadURL: async (url) => { loads.push(url); if (loadURL) await loadURL(url, wc); },
    executeJavaScript: async () => ({ url: "https://github.com/", title: "", text: "", elements }),
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  });
  return wc;
}

const finishPlanner = (actions) => {
  let calls = 0;
  return {
    next: async (context) => {
      calls += 1;
      const base = { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation?.id ?? "obs", criterionIds: [] };
      return calls === 1 && actions ? { ...base, kind: "actions", actions } : { ...base, kind: "finish", evidenceIds: [] };
    },
  };
};

// --- C1: the app's dual-surface browser ---

test("the dual-surface browser hands the lock to the agent adapter only and answers supportsAction", async () => {
  const agentWc = fakeWebContents();
  const visibleWc = fakeWebContents();
  const agentAdapter = new BrowserAdapter({ view: { webContents: agentWc }, permissionMode: "full" });
  const visibleAdapter = new BrowserAdapter({ view: { webContents: visibleWc }, permissionMode: "full" });
  const browser = makeDualSurfaceBrowser({ agentAdapter, visibleAdapter });
  assert.equal(browser.supportsAction("navigate"), true);
  assert.equal(browser.supportsAction("click"), true);
  assert.equal(browser.supportsAction("download"), false);

  const storageRoot = await mkTempRoot();
  const store = await TaskStore.create({ originalRequest: "goal", lock: { rules: [{ kind: "allow_origins", origins: ["https://github.com"] }] } }, { storageRoot });
  // Constructing the controller is what pushes the goal's lock to the browser.
  new TaskController({ store, planner: finishPlanner(), browser, approve: async () => ({ decision: "allow", reasons: [] }), hostVerifier: () => true, permissionMode: "full" });

  assert.deepEqual(await browser.execute({ type: "navigate", url: "https://evil.test/" }), { status: "failed", errorCode: "intent_lock_denied" });
  assert.deepEqual(agentWc.loads, []);
  let agentPrevented = 0;
  agentWc.emit("will-redirect", { preventDefault: () => { agentPrevented += 1; } }, "https://evil.test/x");
  assert.equal(agentPrevented, 1, "the agent surface blocks page-initiated navigation the lock forbids");

  // The person's own surface stays unlocked, including its redirects.
  await browser.userNavigate({ type: "navigate", url: "https://evil.test/" });
  assert.deepEqual(visibleWc.loads, ["https://evil.test/"]);
  let visiblePrevented = 0;
  visibleWc.emit("will-redirect", { preventDefault: () => { visiblePrevented += 1; } }, "https://evil.test/x");
  assert.equal(visiblePrevented, 0);
  await store.close();
});

test("the dual-surface browser reports supportsAction as unknown when the agent adapter cannot say", () => {
  const browser = makeDualSurfaceBrowser({ agentAdapter: { observe() {}, execute() {} }, visibleAdapter: { userNavigate() {} } });
  assert.equal(browser.supportsAction("navigate"), undefined);
  browser.setIntentLock(null); // no throw without setIntentLock on the agent adapter
});

// --- C2 / I1: child agents ---

async function createLockedParent(storageRoot, lock) {
  const goalInput = { originalRequest: "parent goal", ...(lock ? { lock } : {}) };
  const resolvedProfile = resolveTaskProfile({ goalInput, requestedCapabilityProfile: "multi_agent" });
  return TaskStore.create(goalInput, { storageRoot, resolvedProfile });
}

function childPlan(parentTaskId, entryUrls) {
  return {
    taskId: parentTaskId, goalVersion: 1, basedOnObservationId: "obs-1", criterionIds: [], kind: "child_plan",
    parentGoalVersion: 1, requestedAgentCount: entryUrls.length,
    assignments: entryUrls.map((entryUrl, i) => ({ subgoal: `하위 목표 ${i}`, entryUrl })),
  };
}

async function waitFor(fn, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor() timed out");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const admitAll = () => new ResourceAdmission({ memoryMonitor: { canAdmitTask: () => ({ allowed: true }), getPressureLevel: () => "normal" } });

test("a child plan whose entry the parent's lock forbids is rejected, and nothing is created", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await createLockedParent(storageRoot, { rules: [{ kind: "allow_origins", origins: ["https://a.example"] }] });
  const coordinator = new ChildAgentCoordinator({ storageRoot });
  await assert.rejects(
    coordinator.acceptParentPlan(parent.taskId, childPlan(parent.taskId, ["https://a.example/x", "https://b.example/y"]), { parentStore: parent, memoryPolicy: "budgeted" }),
    (e) => e instanceof ChildAgentCoordinatorError && e.code === "intent_lock_denied",
  );
  assert.equal((await parent.getEvents()).filter((e) => e.type === "child_plan_accepted").length, 0);
  await parent.close();
});

test("children inherit the parent's lock and their browser enforces it; a mode-denied child action is skipped, not queued", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await createLockedParent(storageRoot, { rules: [{ kind: "allow_origins", origins: ["https://a.example"] }] });
  const resourceAdmission = admitAll();
  let childBrowser = null;
  let approverCalls = 0;
  const coordinator = new ChildAgentCoordinator({
    storageRoot,
    getResourceAdmission: () => resourceAdmission,
    makeChildBrowser: (_parentTaskId, _childId, origin) => {
      childBrowser = new BrowserAdapter({ view: { webContents: fakeWebContents() }, assignedOrigin: origin });
      return childBrowser;
    },
    // The child proposes a navigate its observe-only mode forbids.
    makePlanner: () => finishPlanner([{ type: "navigate", url: "https://a.example/next" }]),
    approve: async () => { approverCalls += 1; return { decision: "allow", reasons: [] }; },
    hostVerifier: () => true,
  });
  // As TaskHost does, so the child's mailbox can reach its parent's journal.
  coordinator.registerStore(parent.taskId, parent);
  await coordinator.acceptParentPlan(parent.taskId, childPlan(parent.taskId, ["https://a.example/start"]), { parentStore: parent, memoryPolicy: "user_override" });


  // The child's own controller settles out of "running" (a finished child
  // with an unverified default criterion awaits verification).
  const state = await waitFor(async () => {
    const live = [...coordinator._liveChildren.values()][0];
    const current = live?.controller.getSnapshot().state;
    return current && !["idle", "running"].includes(current) ? current : null;
  });
  assert.notEqual(state, "awaiting_approval", "a child never waits for a review nobody can give");
  assert.notEqual(state, "paused", "the child really ran its planner");
  assert.equal(approverCalls, 0, "a mode-denied child action is skipped before the approver");
  assert.ok(childBrowser);
  assert.deepEqual(childBrowser._intentLock?.rules, [{ kind: "allow_origins", origins: ["https://a.example"] }], "the child's controller pushed the inherited lock to its browser");
  await coordinator.cancelPlan(parent.taskId, "test cleanup", { parentStore: parent }).catch(() => {});
  await parent.close();
});

// --- I2: a widening grant is bound to its origin inside the adapter ---

test("a widened navigate may only land on the granted origin", async () => {
  const wc = fakeWebContents();
  const browser = new BrowserAdapter({ view: { webContents: wc }, permissionMode: "observe" });
  assert.deepEqual(await browser.execute({ type: "navigate", url: "https://evil.test/" }, { widenedBy: { kind: "user_once", origin: "https://github.com" } }), { status: "failed", errorCode: "widened_origin_mismatch" });
  assert.deepEqual(wc.loads, []);
  // A malformed origin voids the grant.
  assert.deepEqual(await browser.execute({ type: "navigate", url: "https://github.com/" }, { widenedBy: { kind: "user_once", origin: "https://github.com/path" } }), { status: "failed", errorCode: "permission_mode_denied" });
  assert.equal((await browser.execute({ type: "navigate", url: "https://github.com/a" }, { widenedBy: { kind: "lease", leaseId: "l1", origin: "https://github.com" } })).status, "ok");
  // Without an origin the grant behaves as before.
  assert.equal((await browser.execute({ type: "navigate", url: "https://other.test/" }, { widenedBy: { kind: "user_once" } })).status, "ok");
});

test("a widened follow_link whose live href moved to another origin is refused", async () => {
  const wc = fakeWebContents({ elements: [{ role: "link", name: "x", href: "https://evil.test/p" }] });
  const browser = new BrowserAdapter({ view: { webContents: wc }, permissionMode: "observe" });
  assert.deepEqual(await browser.execute({ type: "follow_link", elementId: "0" }, { widenedBy: { kind: "lease", leaseId: "l1", origin: "https://github.com" } }), { status: "failed", errorCode: "widened_origin_mismatch" });
  assert.deepEqual(wc.loads, []);
});

test("a widened navigate that redirects to another origin is stopped and reported", async () => {
  let prevented = 0;
  const wc = fakeWebContents({
    loadURL: async (url, self) => {
      if (url.startsWith("https://github.com/")) self.emit("will-redirect", { preventDefault: () => { prevented += 1; } }, "https://evil.test/landing");
    },
  });
  const browser = new BrowserAdapter({ view: { webContents: wc }, permissionMode: "observe" });
  assert.deepEqual(await browser.execute({ type: "navigate", url: "https://github.com/r" }, { widenedBy: { kind: "user_once", origin: "https://github.com" } }), { status: "failed", errorCode: "widened_origin_mismatch" });
  assert.equal(prevented, 1);
  // The pin ends with that navigation: a later page redirect is not pinned.
  wc.emit("will-redirect", { preventDefault: () => { prevented += 1; } }, "https://evil.test/later");
  assert.equal(prevented, 1);
});
