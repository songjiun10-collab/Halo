"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const { TaskStore } = require("../main/harness/task-store");
const { ChildAgentCoordinator, ChildAgentCoordinatorError } = require("../main/harness/child-agent-coordinator");
const { BrowserAdapter } = require("../main/harness/browser-adapter");
const { ResourceAdmission } = require("../main/harness/resource-admission");
const { TaskController } = require("../main/harness/task-controller");

async function mkTempRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), "halo-child-coordinator-"));
}

function makeChildPlanProposal(parentTaskId, overrides = {}) {
  return {
    taskId: parentTaskId,
    goalVersion: 1,
    basedOnObservationId: "obs-1",
    criterionIds: [],
    kind: "child_plan",
    parentGoalVersion: 1,
    requestedAgentCount: 2,
    assignments: [
      { subgoal: "첫 번째 하위 목표", entryUrl: "https://a.example/start" },
      { subgoal: "두 번째 하위 목표", entryUrl: "https://b.example/start" },
    ],
    ...overrides,
  };
}

test("acceptParentPlan() mints one child TaskStore per assignment and records ONE child_plan_accepted event before returning", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });
  const coordinator = new ChildAgentCoordinator({ storageRoot });

  const result = await coordinator.acceptParentPlan(parent.taskId, makeChildPlanProposal(parent.taskId), {
    parentStore: parent,
    memoryPolicy: "budgeted",
  });

  assert.equal(result.childIds.length, 2);
  assert.equal(result.state, "queued");

  for (const childId of result.childIds) {
    const childStore = await TaskStore.loadChild(childId, { storageRoot, parentTaskId: parent.taskId });
    await childStore.close();
  }

  const events = await parent.getEvents();
  const accepted = events.filter((e) => e.type === "child_plan_accepted");
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].payload.planId, result.planId);
  assert.equal(accepted[0].payload.assignments.length, 2);
  assert.equal(accepted[0].payload.memoryPolicyAuditEventId, null);
  await parent.close();
});

test("acceptParentPlan() cleans up already-created children when persisting the plan event fails, leaving no orphaned child directories", async () => {
  // If append() itself fails (here: the store was already closed), no child
  // directory should be left dangling on disk for a plan the parent journal
  // never actually recorded.
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });
  await parent.close(); // a closed store's append() always throws "closed"
  const coordinator = new ChildAgentCoordinator({ storageRoot });

  await assert.rejects(
    coordinator.acceptParentPlan(parent.taskId, makeChildPlanProposal(parent.taskId), {
      parentStore: parent,
      memoryPolicy: "budgeted",
    }),
  );

  const childrenRoot = path.join(storageRoot, "tasks", parent.taskId, "children");
  let entries = [];
  try {
    entries = await fs.readdir(childrenRoot);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  assert.deepEqual(entries, []);
});

test("acceptParentPlan() rejects a proposal whose kind is not child_plan", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });
  const coordinator = new ChildAgentCoordinator({ storageRoot });

  await assert.rejects(
    coordinator.acceptParentPlan(
      parent.taskId,
      { taskId: parent.taskId, goalVersion: 1, basedOnObservationId: "o", criterionIds: [], kind: "finish", evidenceIds: [] },
      { parentStore: parent, memoryPolicy: "budgeted" },
    ),
    (err) => err instanceof ChildAgentCoordinatorError && err.code === "invalid_proposal",
  );
  await parent.close();
});

test("acceptParentPlan() rejects when proposal.parentGoalVersion is stale (parent goal amended while children queued)", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });
  await parent.amendGoal({ text: "amendment bumps goalVersion to 2" });
  const coordinator = new ChildAgentCoordinator({ storageRoot });

  await assert.rejects(
    coordinator.acceptParentPlan(parent.taskId, makeChildPlanProposal(parent.taskId, { parentGoalVersion: 1 }), {
      parentStore: parent,
      memoryPolicy: "budgeted",
    }),
    (err) => err instanceof ChildAgentCoordinatorError && err.code === "stale_goal_version",
  );

  const events = await parent.getEvents();
  assert.equal(events.some((e) => e.type === "child_plan_accepted"), false);
  await parent.close();
});

test("acceptParentPlan() rejects a second plan while one is already active for the same parent", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });
  const coordinator = new ChildAgentCoordinator({ storageRoot });
  await coordinator.acceptParentPlan(parent.taskId, makeChildPlanProposal(parent.taskId), {
    parentStore: parent,
    memoryPolicy: "budgeted",
  });

  await assert.rejects(
    coordinator.acceptParentPlan(parent.taskId, makeChildPlanProposal(parent.taskId), {
      parentStore: parent,
      memoryPolicy: "budgeted",
    }),
    (err) => err instanceof ChildAgentCoordinatorError && err.code === "plan_already_active",
  );
  await parent.close();
});

test("cancelPlan() then acceptParentPlan() allows a fresh plan to be accepted", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });
  const coordinator = new ChildAgentCoordinator({ storageRoot });
  const first = await coordinator.acceptParentPlan(parent.taskId, makeChildPlanProposal(parent.taskId), {
    parentStore: parent,
    memoryPolicy: "budgeted",
  });

  await coordinator.cancelPlan(parent.taskId, "user cancelled", { parentStore: parent });
  assert.deepEqual(await coordinator.listChildren(parent.taskId), []);

  const second = await coordinator.acceptParentPlan(parent.taskId, makeChildPlanProposal(parent.taskId), {
    parentStore: parent,
    memoryPolicy: "budgeted",
  });
  assert.notEqual(second.planId, first.planId);
  const children = await coordinator.listChildren(parent.taskId);
  assert.equal(children.length, 2);
  await parent.close();
});

test("distinct-origin assignments are recorded with their own normalized origins", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });
  const coordinator = new ChildAgentCoordinator({ storageRoot });

  await coordinator.acceptParentPlan(parent.taskId, makeChildPlanProposal(parent.taskId), {
    parentStore: parent,
    memoryPolicy: "budgeted",
  });

  const children = await coordinator.listChildren(parent.taskId);
  assert.deepEqual(
    children.map((c) => c.origin).sort(),
    ["https://a.example", "https://b.example"],
  );
  await parent.close();
});

test("same-origin assignments both serialize to the identical normalized origin", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });
  const coordinator = new ChildAgentCoordinator({ storageRoot });

  await coordinator.acceptParentPlan(
    parent.taskId,
    makeChildPlanProposal(parent.taskId, {
      assignments: [
        { subgoal: "a", entryUrl: "https://shared.example/path-one" },
        { subgoal: "b", entryUrl: "https://shared.example:443/path-two" },
      ],
    }),
    { parentStore: parent, memoryPolicy: "budgeted" },
  );

  const children = await coordinator.listChildren(parent.taskId);
  assert.equal(children[0].origin, "https://shared.example");
  assert.equal(children[1].origin, "https://shared.example");
  await parent.close();
});

test("acceptParentPlan() rejects an invalid entryUrl before minting any child store", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });
  const coordinator = new ChildAgentCoordinator({ storageRoot });

  await assert.rejects(
    coordinator.acceptParentPlan(
      parent.taskId,
      makeChildPlanProposal(parent.taskId, {
        assignments: [{ subgoal: "a", entryUrl: "not-a-valid-url" }],
        requestedAgentCount: 1,
      }),
      { parentStore: parent, memoryPolicy: "budgeted" },
    ),
  );

  const childrenRootExists = await fs
    .stat(path.join(storageRoot, "tasks", parent.taskId, "children"))
    .then(() => true)
    .catch((err) => {
      if (err.code === "ENOENT") return false;
      throw err;
    });
  assert.equal(childrenRootExists, false);
  await parent.close();
});

test("acceptParentPlan() rejects requestedAgentCount that does not match assignments.length", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });
  const coordinator = new ChildAgentCoordinator({ storageRoot });

  await assert.rejects(
    coordinator.acceptParentPlan(parent.taskId, makeChildPlanProposal(parent.taskId, { requestedAgentCount: 5 }), {
      parentStore: parent,
      memoryPolicy: "budgeted",
    }),
  );
  await parent.close();
});

test("no child browser/planner construction happens during acceptParentPlan() -- it only creates closed TaskStores", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });
  const coordinator = new ChildAgentCoordinator({ storageRoot });

  const result = await coordinator.acceptParentPlan(parent.taskId, makeChildPlanProposal(parent.taskId), {
    parentStore: parent,
    memoryPolicy: "budgeted",
  });

  // A closed TaskStore instance throws "closed" on any further append -- the
  // coordinator must not be holding it open or doing anything more with it.
  for (const childId of result.childIds) {
    const childStore = await TaskStore.loadChild(childId, { storageRoot, parentTaskId: parent.taskId });
    // If acceptParentPlan had left the store open elsewhere, this second
    // load() would still succeed (load() does not require exclusivity from
    // itself), but there must be no leftover in-flight worker/browser state:
    // the only thing on disk is the immutable goal + a single goal_created
    // event, nothing resembling action_started/observation activity.
    const events = await childStore.getEvents();
    assert.deepEqual(events.map((e) => e.type), ["goal_created"]);
    await childStore.close();
  }
  await parent.close();
});

// --- Review Focus: corrupt/missing parent-child journal link => parent
// pauses (via a thrown error), never reconstructs a child from its own
// self-report.

test("listChildren() throws corrupt_child_link when a referenced child's directory was deleted out from under the parent", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });
  const coordinator = new ChildAgentCoordinator({ storageRoot });
  const result = await coordinator.acceptParentPlan(parent.taskId, makeChildPlanProposal(parent.taskId), {
    parentStore: parent,
    memoryPolicy: "budgeted",
  });

  // Simulate corruption: remove one child's directory directly (bypassing
  // the coordinator), then force reconstruction from the journal by using a
  // FRESH coordinator instance with no in-memory cache.
  await fs.rm(path.join(storageRoot, "tasks", parent.taskId, "children", result.childIds[0]), { recursive: true, force: true });
  const freshCoordinator = new ChildAgentCoordinator({ storageRoot });

  await assert.rejects(
    freshCoordinator.listChildren(parent.taskId),
    (err) => err instanceof ChildAgentCoordinatorError && err.code === "corrupt_child_link",
  );
  await parent.close();
});

test("acceptParentPlan() on a fresh coordinator instance also fails closed on a corrupt existing child link, refusing to start a new plan", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });
  const coordinator = new ChildAgentCoordinator({ storageRoot });
  const result = await coordinator.acceptParentPlan(parent.taskId, makeChildPlanProposal(parent.taskId), {
    parentStore: parent,
    memoryPolicy: "budgeted",
  });
  await fs.rm(path.join(storageRoot, "tasks", parent.taskId, "children", result.childIds[0]), { recursive: true, force: true });

  const freshCoordinator = new ChildAgentCoordinator({ storageRoot });
  await assert.rejects(
    freshCoordinator.acceptParentPlan(parent.taskId, makeChildPlanProposal(parent.taskId), {
      parentStore: parent,
      memoryPolicy: "budgeted",
    }),
    (err) => err instanceof ChildAgentCoordinatorError && err.code === "corrupt_child_link",
  );
  await parent.close();
});

test("listChildren() reconstructs a queued plan from the journal alone on a fresh coordinator instance (process-restart recovery)", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });
  const coordinator = new ChildAgentCoordinator({ storageRoot });
  const result = await coordinator.acceptParentPlan(parent.taskId, makeChildPlanProposal(parent.taskId), {
    parentStore: parent,
    memoryPolicy: "budgeted",
  });

  const freshCoordinator = new ChildAgentCoordinator({ storageRoot });
  const children = await freshCoordinator.listChildren(parent.taskId);
  assert.deepEqual(
    children.map((c) => c.childId).sort(),
    [...result.childIds].sort(),
  );
  assert.ok(children.every((c) => c.state === "queued"));
  await parent.close();
});

test("listChildren() reconstructs a cancelled plan as empty on a fresh coordinator instance", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });
  const coordinator = new ChildAgentCoordinator({ storageRoot });
  await coordinator.acceptParentPlan(parent.taskId, makeChildPlanProposal(parent.taskId), {
    parentStore: parent,
    memoryPolicy: "budgeted",
  });
  await coordinator.cancelPlan(parent.taskId, "user cancelled", { parentStore: parent });

  const freshCoordinator = new ChildAgentCoordinator({ storageRoot });
  assert.deepEqual(await freshCoordinator.listChildren(parent.taskId), []);
  await parent.close();
});

test("listChildren() returns [] for a parent that never accepted any child plan", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });
  const coordinator = new ChildAgentCoordinator({ storageRoot });

  assert.deepEqual(await coordinator.listChildren(parent.taskId), []);
  await parent.close();
});

test("cancelPlan() rejects when there is no active plan to cancel", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });
  const coordinator = new ChildAgentCoordinator({ storageRoot });

  await assert.rejects(
    coordinator.cancelPlan(parent.taskId, "no plan exists", { parentStore: parent }),
    (err) => err instanceof ChildAgentCoordinatorError && err.code === "no_active_plan",
  );
  await parent.close();
});

test("constructor requires storageRoot", () => {
  assert.throws(
    () => new ChildAgentCoordinator({}),
    (err) => err instanceof ChildAgentCoordinatorError && err.code === "invalid_config",
  );
});

test("acceptParentPlan() rejects an unknown memoryPolicy", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });
  const coordinator = new ChildAgentCoordinator({ storageRoot });

  await assert.rejects(
    coordinator.acceptParentPlan(parent.taskId, makeChildPlanProposal(parent.taskId), {
      parentStore: parent,
      memoryPolicy: "unlimited",
    }),
    (err) => err instanceof ChildAgentCoordinatorError && err.code === "invalid_field",
  );
  await parent.close();
});

test("acceptParentPlan() durably carries the trusted memory-policy audit event ID into the parent plan record", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });
  const coordinator = new ChildAgentCoordinator({ storageRoot });

  await coordinator.acceptParentPlan(parent.taskId, makeChildPlanProposal(parent.taskId), {
    parentStore: parent,
    memoryPolicy: "user_override",
    memoryPolicyAuditEventId: "audit-event-123",
  });

  const accepted = (await parent.getEvents()).find((event) => event.type === "child_plan_accepted");
  assert.equal(accepted.payload.memoryPolicyAuditEventId, "audit-event-123");
  await parent.close();
});

test("acceptParentPlan() rejects a memory-policy audit event ID that is empty or too long", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });
  const coordinator = new ChildAgentCoordinator({ storageRoot });

  for (const memoryPolicyAuditEventId of ["", "x".repeat(257)]) {
    await assert.rejects(
      coordinator.acceptParentPlan(parent.taskId, makeChildPlanProposal(parent.taskId), {
        parentStore: parent,
        memoryPolicy: "user_override",
        memoryPolicyAuditEventId,
      }),
      (error) => error instanceof ChildAgentCoordinatorError && error.code === "invalid_field",
    );
  }
  await parent.close();
});

// --- Task 4 (multi-agent background runtime plan): startChild()/
// _attachChild() wired end-to-end with REAL BrowserAdapter instances (fake
// webContents, no Electron) -- not just the admission bookkeeping tested
// above. These exercise the plan's own Step 2/7 verification names: "one
// view per child", "child read only", "child evidence".

function makeFakeChildWebContents(id, { getURL } = {}) {
  const wc = new EventEmitter();
  Object.assign(wc, {
    id,
    getURL: getURL || (() => "https://example.com/"),
    getTitle: () => "",
    close() {},
    stop() {},
    loadURL: async () => {},
    executeJavaScript: async () => ({ url: "https://example.com/", title: "", text: "", elements: [] }),
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
  });
  return wc;
}

// Bypasses ResourceAdmission's budget/pressure checks entirely (see
// resource-admission.js's user_override branch) so these tests do not need
// to model a realistic memory sample -- only that distinct childIds never
// collide as ownerIds.
function makeAlwaysAdmittingResourceAdmission() {
  return new ResourceAdmission({ memoryMonitor: { canAdmitTask: () => ({ allowed: true }), getPressureLevel: () => "normal" } });
}

function finishingChildPlanner() {
  return {
    next: async (context) => ({
      taskId: context.taskId,
      goalVersion: context.goalVersion,
      basedOnObservationId: (context.observation && context.observation.id) || "obs",
      criterionIds: [],
      kind: "finish",
      evidenceIds: [],
    }),
  };
}

// acceptParentPlan() only ever triggers scheduleAdmission() itself as a
// best-effort, un-awaited background call (by design: the plan is durably
// accepted the instant its journal event lands, regardless of whether any
// child manages to start right away). Calling scheduleAdmission() a SECOND
// time from a test to "wait for" that background work would race it --
// startChild()'s _liveChildren/_terminalChildren/duplicate-owner guards
// mean at most one of the two concurrent invocations actually attaches a
// given child, and a test awaiting the LOSING one would observe it
// returning before the winning one's _attachChild() has finished. Poll the
// coordinator's own observable state instead.
async function waitFor(fn, { timeoutMs = 2000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("waitFor() timed out");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

test("one view per child: startChild() constructs a unique BrowserAdapter and planner per child, sharing no webContents id across live siblings", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });

  const madeBrowsers = [];
  const madePlannerChildIds = [];
  const resourceAdmission = makeAlwaysAdmittingResourceAdmission();
  const coordinator = new ChildAgentCoordinator({
    storageRoot,
    getResourceAdmission: () => resourceAdmission,
    makeChildBrowser: (parentTaskId, childId, origin) => {
      const wc = makeFakeChildWebContents(childId);
      const browser = new BrowserAdapter({ view: { webContents: wc }, assignedOrigin: origin });
      madeBrowsers.push({ childId, browser, wc });
      return browser;
    },
    makePlanner: (childId) => {
      madePlannerChildIds.push(childId);
      return finishingChildPlanner();
    },
    approve: async () => ({ decision: "allow", reasons: [] }),
    hostVerifier: () => true,
  });

  // Distinct origins (a.example / b.example, the default proposal fixture)
  // so neither assignment is held back by same-origin serialization -- both
  // start concurrently.
  const { childIds } = await coordinator.acceptParentPlan(parent.taskId, makeChildPlanProposal(parent.taskId), {
    parentStore: parent,
    memoryPolicy: "user_override",
  });
  const children = await waitFor(async () => {
    const list = await coordinator.listChildren(parent.taskId);
    return list.length === 2 && list.every((c) => c.state !== "queued") ? list : null;
  });

  assert.equal(childIds.length, 2);
  assert.deepEqual(madePlannerChildIds.sort(), [...childIds].sort());
  assert.equal(madeBrowsers.length, 2);
  assert.notEqual(madeBrowsers[0].browser, madeBrowsers[1].browser);
  assert.notEqual(madeBrowsers[0].wc.id, madeBrowsers[1].wc.id);
  assert.deepEqual(madeBrowsers.map((b) => b.childId).sort(), [...childIds].sort());

  assert.equal(children.length, 2);
  assert.ok(children.every((c) => c.state === "running"));

  await coordinator.cancelPlan(parent.taskId, "test cleanup", { parentStore: parent });
  await parent.close();
});

test("child read only: a child's navigate proposal is never dispatched through the controller, and the child's own adapter also denies it directly", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });

  let executeCalls = [];
  let liveBrowser = null;
  const resourceAdmission = makeAlwaysAdmittingResourceAdmission();
  const coordinator = new ChildAgentCoordinator({
    storageRoot,
    getResourceAdmission: () => resourceAdmission,
    makeChildBrowser: (parentTaskId, childId, origin) => {
      const wc = makeFakeChildWebContents(childId);
      const browser = new BrowserAdapter({ view: { webContents: wc }, assignedOrigin: origin });
      const realExecute = browser.execute.bind(browser);
      browser.execute = async (action, opts) => {
        executeCalls.push(action.type);
        return realExecute(action, opts);
      };
      liveBrowser = browser;
      return browser;
    },
    makePlanner: () => {
      let call = 0;
      return {
        next: async (context) => {
          call += 1;
          if (call === 1) {
            return {
              taskId: context.taskId,
              goalVersion: context.goalVersion,
              basedOnObservationId: (context.observation && context.observation.id) || "obs",
              criterionIds: [],
              kind: "actions",
              actions: [{ type: "navigate", url: "https://attacker.example/" }],
            };
          }
          return {
            taskId: context.taskId,
            goalVersion: context.goalVersion,
            basedOnObservationId: (context.observation && context.observation.id) || "obs",
            criterionIds: [],
            kind: "finish",
            evidenceIds: [],
          };
        },
      };
    },
    approve: async () => {
      throw new Error("a disallowed action must be skipped before ever reaching the approver");
    },
    hostVerifier: () => true,
  });

  const singleAssignmentProposal = makeChildPlanProposal(parent.taskId, {
    assignments: [{ subgoal: "읽기 전용 하위 목표", entryUrl: "https://a.example/start" }],
    requestedAgentCount: 1,
  });
  await coordinator.acceptParentPlan(parent.taskId, singleAssignmentProposal, {
    parentStore: parent,
    memoryPolicy: "user_override",
  });
  await waitFor(async () => {
    const list = await coordinator.listChildren(parent.taskId);
    return list.length === 1 && list[0].state !== "queued" ? list : null;
  });

  // Enforcement path 1: TaskController's own dispatch loop skips a
  // disallowed action type before ever calling browser.execute() or the
  // approver (permission-policy.js's READ_ONLY set for "observe" mode is
  // exactly {observe, scroll} -- navigate is not in it).
  assert.equal(executeCalls.includes("navigate"), false);

  // Enforcement path 2: independent of the controller, the SAME adapter
  // instance the child is actually running against also denies the action
  // directly -- proving its permissionMode really is "observe" (set via
  // TaskController's constructor propagating setPermissionMode), not just
  // that the controller chose not to ask.
  assert.ok(liveBrowser);
  assert.deepEqual(await liveBrowser.execute({ type: "navigate", url: "https://attacker.example/" }), {
    status: "failed",
    errorCode: "permission_mode_denied",
  });

  await coordinator.cancelPlan(parent.taskId, "test cleanup", { parentStore: parent });
  await parent.close();
});

// --- Task 4: verifyChildResult() -- never trusts a child's self-report,
// only its own durable checkpoint cross-checked against real
// evidence_recorded events in the child's own journal.

test("child evidence: verifyChildResult() rejects a fabricated self-report with no durable evidence_recorded backing it", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });
  const coordinator = new ChildAgentCoordinator({ storageRoot });
  const { childIds } = await coordinator.acceptParentPlan(
    parent.taskId,
    makeChildPlanProposal(parent.taskId, {
      assignments: [{ subgoal: "a", entryUrl: "https://a.example/start" }],
      requestedAgentCount: 1,
    }),
    { parentStore: parent, memoryPolicy: "budgeted" },
  );
  const childId = childIds[0];

  const childStore = await TaskStore.loadChild(childId, { storageRoot, parentTaskId: parent.taskId });
  // Fabricated self-report: the checkpoint claims a verified criterion, but
  // no matching evidence_recorded event was ever appended -- exactly the
  // self-report-laundering pattern this method exists to catch.
  await childStore.checkpoint({
    task: { state: "completed" },
    criteriaStatus: [["C1", { status: "verified", evidenceId: "ev-fabricated" }]],
  });
  await childStore.close();

  const result = await coordinator.verifyChildResult(parent.taskId, childId, { parentStore: parent });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing_evidence_record");

  const events = await parent.getEvents();
  assert.equal(events.some((e) => e.type === "child_result_verified"), false);
  await parent.close();
});

test("child evidence: verifyChildResult() rejects a child with no checkpoint at all", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });
  const coordinator = new ChildAgentCoordinator({ storageRoot });
  const { childIds } = await coordinator.acceptParentPlan(
    parent.taskId,
    makeChildPlanProposal(parent.taskId, {
      assignments: [{ subgoal: "a", entryUrl: "https://a.example/start" }],
      requestedAgentCount: 1,
    }),
    { parentStore: parent, memoryPolicy: "budgeted" },
  );

  const result = await coordinator.verifyChildResult(parent.taskId, childIds[0], { parentStore: parent });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "no_checkpoint");
  await parent.close();
});

test("child evidence: verifyChildResult() accepts and durably records a criterion backed by a real evidence_recorded event in the child's own journal", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });
  const coordinator = new ChildAgentCoordinator({ storageRoot });
  const { childIds, planId } = await coordinator.acceptParentPlan(
    parent.taskId,
    makeChildPlanProposal(parent.taskId, {
      assignments: [{ subgoal: "a", entryUrl: "https://a.example/start" }],
      requestedAgentCount: 1,
    }),
    { parentStore: parent, memoryPolicy: "budgeted" },
  );
  const childId = childIds[0];

  const childStore = await TaskStore.loadChild(childId, { storageRoot, parentTaskId: parent.taskId });
  await childStore.append({
    type: "evidence_recorded",
    payload: {
      evidence: {
        id: "ev-real",
        taskId: childId,
        goalVersion: 1,
        criterionId: "C1",
        kind: "host_check",
        at: new Date().toISOString(),
        verification: "verified",
        verifierId: "host",
      },
    },
  });
  await childStore.checkpoint({
    task: { state: "completed" },
    criteriaStatus: [["C1", { status: "verified", evidenceId: "ev-real" }]],
  });
  await childStore.close();

  const result = await coordinator.verifyChildResult(parent.taskId, childId, { parentStore: parent });
  assert.equal(result.ok, true);
  assert.deepEqual(result.verifiedCriteria, [{ criterionId: "C1", evidenceId: "ev-real" }]);

  const events = await parent.getEvents();
  const verified = events.find((e) => e.type === "child_result_verified");
  assert.ok(verified);
  assert.equal(verified.payload.childId, childId);
  assert.equal(verified.payload.planId, planId);
  assert.deepEqual(verified.payload.verifiedCriteria, [{ criterionId: "C1", evidenceId: "ev-real" }]);
  await parent.close();
});

// --- Task 4 Step 6: cancelPlan() draining a LIVE (already-started) child --
// not just a still-queued one.

test("cancelPlan() stops a live child's controller and releases its resource lease, unblocking a same-origin sibling that was serialized behind it", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });

  const resourceAdmission = makeAlwaysAdmittingResourceAdmission();
  const disposedChildIds = [];
  const coordinator = new ChildAgentCoordinator({
    storageRoot,
    getResourceAdmission: () => resourceAdmission,
    makeChildBrowser: (parentTaskId, childId, origin) => {
      const wc = makeFakeChildWebContents(childId);
      const browser = new BrowserAdapter({ view: { webContents: wc }, assignedOrigin: origin });
      const realDispose = browser.dispose.bind(browser);
      browser.dispose = async () => {
        disposedChildIds.push(childId);
        return realDispose();
      };
      return browser;
    },
    // Reaches "finish" on the very first proposal -- with the default C1
    // criterion (verification:"user", unmet), that settles at
    // "awaiting_verification": paused, but NOT "completed"/"stopped", so the
    // coordinator still counts it as a live child cancelPlan() must drain
    // (as opposed to a still-"queued" sibling that never started at all).
    makePlanner: () => finishingChildPlanner(),
    approve: async () => ({ decision: "allow", reasons: [] }),
    hostVerifier: () => true,
  });

  // Same origin on both assignments: the second must stay queued (origin-
  // serialized) behind the first's live run.
  const { childIds } = await coordinator.acceptParentPlan(
    parent.taskId,
    makeChildPlanProposal(parent.taskId, {
      assignments: [
        { subgoal: "첫 번째", entryUrl: "https://shared.example/one" },
        { subgoal: "두 번째", entryUrl: "https://shared.example/two" },
      ],
    }),
    { parentStore: parent, memoryPolicy: "user_override" },
  );
  const children = await waitFor(async () => {
    const list = await coordinator.listChildren(parent.taskId);
    const first = list.find((c) => c.childId === childIds[0]);
    return first && first.state !== "queued" ? list : null;
  });
  assert.equal(children.find((c) => c.childId === childIds[0]).state, "running");
  assert.equal(children.find((c) => c.childId === childIds[1]).state, "queued");

  await coordinator.cancelPlan(parent.taskId, "user cancelled", { parentStore: parent });

  // cancelPlan() records child_plan_cancelled BEFORE scheduleAdmission's own
  // best-effort retry loop could ever start the still-queued sibling, so the
  // plan is simply gone -- listChildren() returns [] for a cancelled plan.
  assert.deepEqual(await coordinator.listChildren(parent.taskId), []);
  assert.ok(disposedChildIds.includes(childIds[0]), "the live child's view must be torn down, not leaked");

  await parent.close();
});

async function createQueuedChildPlan(storageRoot) {
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });
  const plannerlessCoordinator = new ChildAgentCoordinator({ storageRoot });
  const { childIds } = await plannerlessCoordinator.acceptParentPlan(parent.taskId, makeChildPlanProposal(parent.taskId, {
    assignments: [{ subgoal: "child goal", entryUrl: "https://a.example/start" }],
    requestedAgentCount: 1,
  }), { parentStore: parent, memoryPolicy: "user_override" });
  return { parent, childId: childIds[0] };
}

function makeRecordingAdmission({ storageRoot, parentTaskId, childId, cleanupState }) {
  let released = false;
  return {
    async acquire({ ownerId }) {
      assert.equal(ownerId, childId);
      return { admitted: true, leaseId: "lease-child" };
    },
    async release(leaseId) {
      assert.equal(leaseId, "lease-child");
      // A child store must be reopenable before its lease becomes available
      // to another assignment. Trying a real load catches lock leaks rather
      // than asserting only that a cleanup callback happened to be called.
      try {
        const reopened = await TaskStore.loadChild(childId, { storageRoot, parentTaskId });
        await reopened.close();
        cleanupState.storeReopenedBeforeLeaseRelease = true;
      } catch {
        cleanupState.storeReopenedBeforeLeaseRelease = false;
      }
      cleanupState.controllerStoppedBeforeLeaseRelease = cleanupState.controllerStopped ?? null;
      cleanupState.browserDisposedBeforeLeaseRelease = cleanupState.browserDisposed;
      released = true;
    },
    get released() { return released; },
  };
}

test("child attach rollback: planner construction failure tears down browser/store before releasing its lease", async () => {
  const storageRoot = await mkTempRoot();
  const { parent, childId } = await createQueuedChildPlan(storageRoot);
  const cleanupState = { browserDisposed: false };
  const admission = makeRecordingAdmission({ storageRoot, parentTaskId: parent.taskId, childId, cleanupState });
  let browserCreated = 0;
  const coordinator = new ChildAgentCoordinator({
    storageRoot,
    getResourceAdmission: () => admission,
    makeChildBrowser: () => {
      browserCreated += 1;
      return {
        userNavigate: async () => ({ status: "ok" }),
        dispose: async () => { cleanupState.browserDisposed = true; },
      };
    },
    makePlanner: () => { throw new Error("planner startup failed"); },
  });

  await assert.rejects(coordinator.scheduleAdmission(parent.taskId), /planner startup failed/);
  assert.equal(browserCreated, 1);
  assert.equal(cleanupState.browserDisposed, true);
  assert.equal(cleanupState.browserDisposedBeforeLeaseRelease, true);
  assert.equal(cleanupState.storeReopenedBeforeLeaseRelease, true);
  assert.equal(admission.released, true);
  assert.equal((await coordinator.listChildren(parent.taskId))[0].state, "failed");
  await parent.close();
});

test("child attach rollback: resume failure removes live registration and tears down every owned resource before lease release", async () => {
  const storageRoot = await mkTempRoot();
  const { parent, childId } = await createQueuedChildPlan(storageRoot);
  const cleanupState = { controllerStopped: false, browserDisposed: false, plannerClosed: false };
  const admission = makeRecordingAdmission({ storageRoot, parentTaskId: parent.taskId, childId, cleanupState });
  const coordinator = new ChildAgentCoordinator({
    storageRoot,
    getResourceAdmission: () => admission,
    makeChildBrowser: () => ({
      userNavigate: async () => ({ status: "ok" }),
      dispose: async () => { cleanupState.browserDisposed = true; },
    }),
    hostVerifier: () => true,
    makePlanner: () => ({
      next: async () => { throw new Error("not reached"); },
      close: async () => { cleanupState.plannerClosed = true; },
    }),
  });
  const originalResume = TaskController.prototype.resume;
  const originalStop = TaskController.prototype.stop;
  TaskController.prototype.resume = async function resumeFailure() {
    throw new Error("controller resume failed");
  };
  TaskController.prototype.stop = async function stopForRollback() {
    cleanupState.controllerStopped = true;
    return originalStop.call(this);
  };
  let attachError;
  try {
    try {
      await coordinator.scheduleAdmission(parent.taskId);
      assert.fail("scheduleAdmission should reject after resume failure");
    } catch (error) {
      attachError = error;
      assert.match(error.message, /controller resume failed/);
    }
  } finally {
    TaskController.prototype.resume = originalResume;
    TaskController.prototype.stop = originalStop;
  }

  assert.equal(cleanupState.controllerStopped, true);
  assert.equal(cleanupState.controllerStoppedBeforeLeaseRelease, true);
  assert.equal(cleanupState.browserDisposed, true);
  assert.equal(cleanupState.plannerClosed, true);
  assert.equal(cleanupState.browserDisposedBeforeLeaseRelease, true, JSON.stringify(attachError.cleanupErrors));
  assert.equal(cleanupState.storeReopenedBeforeLeaseRelease, true);
  assert.equal(admission.released, true);
  assert.equal(coordinator._liveChildren.has(childId), false);
  assert.equal((await coordinator.listChildren(parent.taskId))[0].state, "failed");
  await parent.close();
});

// --- Subagent communication protocol Task 4: handleSendMessage()/
// listPendingMessages()/recordMessagesConsumed() -- the relationship/quota
// authority layer above message-mailbox.js's pure journal mechanics. These
// exercise the coordinator directly against an accepted plan (registering
// stores by hand, exactly like task-host.js does in production) rather than
// spinning up a full live child for every case, except for one true
// end-to-end test near the bottom.

function makeSendMessageProposal(overrides = {}) {
  return {
    kind: "send_message",
    recipientTaskId: "00000000-0000-0000-0000-000000000000",
    messageKind: "progress",
    idempotencyKey: `idem-${Math.random().toString(36).slice(2)}`,
    text: "hello",
    ...overrides,
  };
}

async function setUpAcceptedPlan(coordinator, storageRoot) {
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });
  coordinator.registerStore(parent.taskId, parent);
  const { childIds } = await coordinator.acceptParentPlan(parent.taskId, makeChildPlanProposal(parent.taskId), {
    parentStore: parent,
    memoryPolicy: "user_override",
  });
  const childStores = [];
  for (const childId of childIds) {
    const childStore = await TaskStore.loadChild(childId, { storageRoot, parentTaskId: parent.taskId });
    coordinator.registerStore(childId, childStore);
    childStores.push(childStore);
  }
  return { parent, childIds, childStores };
}

test("handleSendMessage() lets a parent message its own accepted child; it lands in the parent's own journal only", async () => {
  const storageRoot = await mkTempRoot();
  const coordinator = new ChildAgentCoordinator({ storageRoot });
  const { parent, childIds, childStores } = await setUpAcceptedPlan(coordinator, storageRoot);

  const result = await coordinator.handleSendMessage(
    parent.taskId,
    makeSendMessageProposal({ recipientTaskId: childIds[0] }),
  );
  assert.equal(result.duplicate, false);
  assert.ok(result.messageId);

  const parentEvents = await parent.getEvents();
  const sent = parentEvents.filter((e) => e.type === "message_sent");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.senderTaskId, parent.taskId);
  assert.equal(sent[0].payload.recipientTaskId, childIds[0]);
  assert.equal(sent[0].payload.parentGoalVersion, 1);

  const childEvents = await childStores[0].getEvents();
  assert.equal(childEvents.some((e) => e.type === "message_sent"), false);

  await parent.close();
  await Promise.all(childStores.map((s) => s.close()));
});

test("handleSendMessage() rejects a parent messaging a UUID that is not one of its own accepted children", async () => {
  const storageRoot = await mkTempRoot();
  const coordinator = new ChildAgentCoordinator({ storageRoot });
  const { parent, childStores } = await setUpAcceptedPlan(coordinator, storageRoot);

  await assert.rejects(
    coordinator.handleSendMessage(
      parent.taskId,
      makeSendMessageProposal({ recipientTaskId: "99999999-9999-9999-9999-999999999999" }),
    ),
    (err) => err instanceof ChildAgentCoordinatorError && err.code === "unauthorized_route",
  );

  await parent.close();
  await Promise.all(childStores.map((s) => s.close()));
});

test("handleSendMessage() lets a child message its own parent", async () => {
  const storageRoot = await mkTempRoot();
  const coordinator = new ChildAgentCoordinator({ storageRoot });
  const { parent, childIds, childStores } = await setUpAcceptedPlan(coordinator, storageRoot);

  const result = await coordinator.handleSendMessage(
    childIds[0],
    makeSendMessageProposal({ recipientTaskId: parent.taskId, messageKind: "question" }),
  );
  assert.equal(result.duplicate, false);

  const childEvents = await childStores[0].getEvents();
  const sent = childEvents.filter((e) => e.type === "message_sent");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.senderTaskId, childIds[0]);
  assert.equal(sent[0].payload.recipientTaskId, parent.taskId);

  await parent.close();
  await Promise.all(childStores.map((s) => s.close()));
});

test("handleSendMessage() rejects a child claiming a recipient other than its own parent (sibling/unrelated routing)", async () => {
  const storageRoot = await mkTempRoot();
  const coordinator = new ChildAgentCoordinator({ storageRoot });
  const { childIds, parent, childStores } = await setUpAcceptedPlan(coordinator, storageRoot);

  await assert.rejects(
    coordinator.handleSendMessage(childIds[0], makeSendMessageProposal({ recipientTaskId: childIds[1] })),
    (err) => err instanceof ChildAgentCoordinatorError && err.code === "unauthorized_route",
  );
  await assert.rejects(
    coordinator.handleSendMessage(
      childIds[0],
      makeSendMessageProposal({ recipientTaskId: "99999999-9999-9999-9999-999999999999" }),
    ),
    (err) => err instanceof ChildAgentCoordinatorError && err.code === "unauthorized_route",
  );

  await parent.close();
  await Promise.all(childStores.map((s) => s.close()));
});

test("handleSendMessage() rejects a child attempting to send a steer message (parent-to-child only)", async () => {
  const storageRoot = await mkTempRoot();
  const coordinator = new ChildAgentCoordinator({ storageRoot });
  const { childIds, parent, childStores } = await setUpAcceptedPlan(coordinator, storageRoot);

  await assert.rejects(
    coordinator.handleSendMessage(
      childIds[0],
      makeSendMessageProposal({ recipientTaskId: parent.taskId, messageKind: "steer" }),
    ),
    (err) => err instanceof ChildAgentCoordinatorError && err.code === "unauthorized_route",
  );

  await parent.close();
  await Promise.all(childStores.map((s) => s.close()));
});

test("handleSendMessage() rejects a second unobserved parent-to-child steer while the first is still pending", async () => {
  const storageRoot = await mkTempRoot();
  const coordinator = new ChildAgentCoordinator({ storageRoot });
  const { parent, childIds, childStores } = await setUpAcceptedPlan(coordinator, storageRoot);

  await coordinator.handleSendMessage(
    parent.taskId,
    makeSendMessageProposal({ recipientTaskId: childIds[0], messageKind: "steer", text: "first steer" }),
  );
  await assert.rejects(
    coordinator.handleSendMessage(
      parent.taskId,
      makeSendMessageProposal({ recipientTaskId: childIds[0], messageKind: "steer", text: "second steer" }),
    ),
    (err) => err instanceof ChildAgentCoordinatorError && err.code === "pending_steer_exists",
  );

  await parent.close();
  await Promise.all(childStores.map((s) => s.close()));
});

test("handleSendMessage() rejects a 4th steer to the same child within the rolling rate window", async () => {
  const storageRoot = await mkTempRoot();
  const coordinator = new ChildAgentCoordinator({ storageRoot });
  const { parent, childIds, childStores } = await setUpAcceptedPlan(coordinator, storageRoot);

  // Consume each prior steer immediately so the "one unobserved steer" cap
  // never blocks this test before the rate cap has a chance to.
  for (let i = 0; i < 3; i++) {
    const sent = await coordinator.handleSendMessage(
      parent.taskId,
      makeSendMessageProposal({ recipientTaskId: childIds[0], messageKind: "steer", text: `steer ${i}` }),
    );
    await coordinator.recordMessagesConsumed(childIds[0], [sent.messageId]);
  }
  await assert.rejects(
    coordinator.handleSendMessage(
      parent.taskId,
      makeSendMessageProposal({ recipientTaskId: childIds[0], messageKind: "steer", text: "steer 3" }),
    ),
    (err) => err instanceof ChildAgentCoordinatorError && err.code === "steer_rate_limit",
  );

  await parent.close();
  await Promise.all(childStores.map((s) => s.close()));
});

test("handleSendMessage() rejects delivery to a child whose accepted parentGoalVersion is now stale", async () => {
  const storageRoot = await mkTempRoot();
  const coordinator = new ChildAgentCoordinator({ storageRoot });
  const { parent, childIds, childStores } = await setUpAcceptedPlan(coordinator, storageRoot);

  await parent.amendGoal({ text: "parent goal moved on after accepting the plan" });

  await assert.rejects(
    coordinator.handleSendMessage(parent.taskId, makeSendMessageProposal({ recipientTaskId: childIds[0] })),
    (err) => err instanceof ChildAgentCoordinatorError && err.code === "stale_goal_version",
  );

  await parent.close();
  await Promise.all(childStores.map((s) => s.close()));
});

test("handleSendMessage() rejects a child's report to its parent after the accepted parent goal becomes stale", async () => {
  const storageRoot = await mkTempRoot();
  const coordinator = new ChildAgentCoordinator({ storageRoot });
  const { parent, childIds, childStores } = await setUpAcceptedPlan(coordinator, storageRoot);
  await parent.amendGoal({ text: "the accepted child assignment is stale now" });

  await assert.rejects(
    coordinator.handleSendMessage(childIds[0], makeSendMessageProposal({ recipientTaskId: parent.taskId })),
    (err) => err instanceof ChildAgentCoordinatorError && err.code === "stale_goal_version",
  );
  assert.deepEqual(await coordinator.listPendingMessages(parent.taskId), []);
  await parent.close();
  await Promise.all(childStores.map((s) => s.close()));
});

test("concurrent parent steers serialize admission so only one unobserved steer is appended", async () => {
  const storageRoot = await mkTempRoot();
  const coordinator = new ChildAgentCoordinator({ storageRoot });
  const { parent, childIds, childStores } = await setUpAcceptedPlan(coordinator, storageRoot);
  const results = await Promise.allSettled([
    coordinator.handleSendMessage(parent.taskId, makeSendMessageProposal({ recipientTaskId: childIds[0], messageKind: "steer", idempotencyKey: "race-1", text: "first" })),
    coordinator.handleSendMessage(parent.taskId, makeSendMessageProposal({ recipientTaskId: childIds[0], messageKind: "steer", idempotencyKey: "race-2", text: "second" })),
  ]);

  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(results.filter((r) => r.status === "rejected" && r.reason.code === "pending_steer_exists").length, 1);
  const pending = await coordinator.listPendingMessages(childIds[0]);
  assert.equal(pending.filter((message) => message.kind === "steer").length, 1);
  await parent.close();
  await Promise.all(childStores.map((s) => s.close()));
});

test("parent goal amendments serialize with child message acceptance so a checked assignment cannot go stale before append", async () => {
  const storageRoot = await mkTempRoot();
  const coordinator = new ChildAgentCoordinator({ storageRoot });
  const { parent, childIds, childStores } = await setUpAcceptedPlan(coordinator, storageRoot);
  const originalSend = coordinator._mailbox.send.bind(coordinator._mailbox);
  let markSendEntered;
  let releaseSend;
  const sendEntered = new Promise((resolve) => { markSendEntered = resolve; });
  const sendGate = new Promise((resolve) => { releaseSend = resolve; });
  coordinator._mailbox.send = async (envelope) => {
    markSendEntered();
    await sendGate;
    return originalSend(envelope);
  };

  const send = coordinator.handleSendMessage(childIds[0], makeSendMessageProposal({ recipientTaskId: parent.taskId }));
  await sendEntered;
  let amendmentFinished = false;
  const amendment = coordinator.withParentGoalLock(parent.taskId, () => parent.amendGoal({ text: "new parent goal" }))
    .then((goal) => { amendmentFinished = true; return goal; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(amendmentFinished, false, "goal amendment must wait until the in-progress message acceptance reaches its durable append");
  releaseSend();
  const [accepted] = await Promise.all([send, amendment]);
  assert.ok(accepted.messageId);
  assert.equal(amendmentFinished, true);
  await parent.close();
  await Promise.all(childStores.map((s) => s.close()));
});

test("listPendingMessages() aggregates pending messages from every accepted child for a parent", async () => {
  const storageRoot = await mkTempRoot();
  const coordinator = new ChildAgentCoordinator({ storageRoot });
  const { parent, childIds, childStores } = await setUpAcceptedPlan(coordinator, storageRoot);

  const fromFirst = await coordinator.handleSendMessage(
    childIds[0],
    makeSendMessageProposal({ recipientTaskId: parent.taskId, messageKind: "progress", text: "from first" }),
  );
  const fromSecond = await coordinator.handleSendMessage(
    childIds[1],
    makeSendMessageProposal({ recipientTaskId: parent.taskId, messageKind: "progress", text: "from second" }),
  );

  const pendingForParent = await coordinator.listPendingMessages(parent.taskId);
  assert.deepEqual(
    pendingForParent.map((m) => m.messageId).sort(),
    [fromFirst.messageId, fromSecond.messageId].sort(),
  );

  const pendingForFirstChild = await coordinator.listPendingMessages(childIds[0]);
  assert.deepEqual(pendingForFirstChild, []);

  await parent.close();
  await Promise.all(childStores.map((s) => s.close()));
});

test("recordMessagesConsumed() removes consumed IDs from a later listPendingMessages() call and fails closed on a non-pending ID", async () => {
  const storageRoot = await mkTempRoot();
  const coordinator = new ChildAgentCoordinator({ storageRoot });
  const { parent, childIds, childStores } = await setUpAcceptedPlan(coordinator, storageRoot);

  const sent = await coordinator.handleSendMessage(parent.taskId, makeSendMessageProposal({ recipientTaskId: childIds[0] }));
  assert.deepEqual((await coordinator.listPendingMessages(childIds[0])).map((m) => m.messageId), [sent.messageId]);

  await coordinator.recordMessagesConsumed(childIds[0], [sent.messageId], 3);
  assert.deepEqual(await coordinator.listPendingMessages(childIds[0]), []);

  await assert.rejects(
    coordinator.recordMessagesConsumed(childIds[0], ["not-a-real-pending-id"]),
    (err) => err instanceof ChildAgentCoordinatorError,
  );

  await parent.close();
  await Promise.all(childStores.map((s) => s.close()));
});

test("end-to-end: a live child's own planner proposes send_message and it durably lands in the child's own journal, discoverable by the parent via listPendingMessages()", async () => {
  const storageRoot = await mkTempRoot();
  const parent = await TaskStore.create({ originalRequest: "parent goal" }, { storageRoot });
  const resourceAdmission = makeAlwaysAdmittingResourceAdmission();

  let sentMessageProposal = false;
  const scriptedPlanner = () => ({
    next: async (context) => {
      if (!sentMessageProposal) {
        sentMessageProposal = true;
        return {
          taskId: context.taskId,
          goalVersion: context.goalVersion,
          basedOnObservationId: (context.observation && context.observation.id) || "obs",
          criterionIds: [],
          kind: "send_message",
          recipientTaskId: parent.taskId,
          messageKind: "progress",
          idempotencyKey: "e2e-1",
          text: "child reporting in",
        };
      }
      return {
        taskId: context.taskId,
        goalVersion: context.goalVersion,
        basedOnObservationId: (context.observation && context.observation.id) || "obs",
        criterionIds: [],
        kind: "finish",
        evidenceIds: [],
      };
    },
  });

  const coordinator = new ChildAgentCoordinator({
    storageRoot,
    getResourceAdmission: () => resourceAdmission,
    makeChildBrowser: (parentTaskId, childId, origin) => {
      const wc = makeFakeChildWebContents(childId);
      return new BrowserAdapter({ view: { webContents: wc }, assignedOrigin: origin });
    },
    makePlanner: () => scriptedPlanner(),
    approve: async () => ({ decision: "allow", reasons: [] }),
    hostVerifier: () => true,
  });
  coordinator.registerStore(parent.taskId, parent);

  const { childIds } = await coordinator.acceptParentPlan(
    parent.taskId,
    makeChildPlanProposal(parent.taskId, {
      assignments: [{ subgoal: "메시지를 보내고 완료", entryUrl: "https://a.example/start" }],
      requestedAgentCount: 1,
    }),
    { parentStore: parent, memoryPolicy: "user_override" },
  );

  // Admission attaches the live child in the background -- wait for it
  // before polling for its message, since listPendingMessages()/the mailbox
  // needs the child's store registered (via _liveChildren) to resolve it.
  await waitFor(async () => (coordinator._liveChildren.has(childIds[0]) ? true : null));

  // The message a child sends lands in the CHILD's own journal (see
  // handleSendMessage()'s "lets a child message its own parent" test above),
  // never the parent's -- so the parent side of this pipeline is exercised
  // through the public listPendingMessages() aggregation, exactly as the
  // parent's own controller would consume it.
  const pending = await waitFor(async () => {
    const list = await coordinator.listPendingMessages(parent.taskId);
    return list.length > 0 ? list : null;
  });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].senderTaskId, childIds[0]);
  assert.equal(pending[0].recipientTaskId, parent.taskId);
  assert.equal(pending[0].text, "child reporting in");

  // The child never paused because of the messaging turn -- it kept going
  // and reached its next planner turn ("finish"), which -- since finish
  // carries no evidence for this child's own required criteria -- lands it
  // in awaiting_verification, not stuck mid-loop. listChildren() reports
  // "running" for any not-yet-retired live child regardless of its true
  // internal pauseReason/state, so the controller's own snapshot is read
  // directly here rather than through that aggregate view.
  await waitFor(async () => {
    const live = coordinator._liveChildren.get(childIds[0]);
    return live && live.controller.getSnapshot().state !== "running" ? live : null;
  });
  const snapshot = coordinator._liveChildren.get(childIds[0]).controller.getSnapshot();
  assert.equal(snapshot.state, "awaiting_verification");
  assert.equal(snapshot.budgets.plannerCallsUsed, 2);

  await parent.close();
});
