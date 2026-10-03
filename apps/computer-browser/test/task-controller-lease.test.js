"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskStore } = require("../main/harness/task-store");
const { TaskController, TaskControllerError } = require("../main/harness/task-controller");

async function makeStore(extra = {}) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-lease-"));
  return TaskStore.create({ originalRequest: "goal", ...extra }, { storageRoot });
}

// Proposes each batch in turn, then finishes.
function plannerFor(...batches) {
  let calls = 0;
  return {
    next: async (context) => {
      const base = { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation?.id ?? "obs", criterionIds: [] };
      const actions = batches[calls];
      calls += 1;
      return actions ? { ...base, kind: "actions", actions } : { ...base, kind: "finish", evidenceIds: [] };
    },
  };
}

function fakeBrowser() {
  const calls = [];
  return {
    calls,
    lock: undefined,
    setIntentLock(lock) { this.lock = lock; },
    supportsAction: (type) => ["navigate", "follow_link", "scroll", "observe"].includes(type),
    observe: async () => ({ id: "obs", url: "https://page.test/", elements: [] }),
    execute: async (action, opts = {}) => { calls.push({ type: action.type, widenedBy: opts.widenedBy ?? null }); return { status: "ok" }; },
  };
}

const allow = async () => ({ decision: "allow", reasons: [] });
const deny = async () => ({ decision: "deny", reasons: ["approver said no"] });
const go = (url = "https://github.com/a") => ({ type: "navigate", url });
const clockAt = (t) => { const c = { t, now: () => c.t }; return c; };
const monotonicNow = () => Number(process.hrtime.bigint()) / 1_000_000;

test("a lock-denied action is journaled and never reaches the approver or the browser", async () => {
  const store = await makeStore({ lock: { rules: [{ kind: "deny_action", action: "navigate" }] } });
  let approverCalls = 0;
  const browser = fakeBrowser();
  const controller = new TaskController({ store, planner: plannerFor([go()]), browser, approve: async () => { approverCalls += 1; return { decision: "allow", reasons: [] }; }, hostVerifier: () => true, permissionMode: "full" });
  assert.equal(browser.lock.rules[0].action, "navigate", "the controller hands the lock to the browser");
  await controller.start();
  assert.equal(approverCalls, 0);
  assert.deepEqual(browser.calls, []);
  const notes = (await store.getEvents()).filter((e) => e.type === "note" && e.payload.kind === "lock_denied");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].payload.reason, "lock_action_denied");
  await store.close();
});

test("a lock-denied routine step is denied, not skipped", async () => {
  const store = await makeStore({ lock: { rules: [{ kind: "deny_action", action: "navigate" }] } });
  const browser = fakeBrowser();
  const denied = [];
  const routineRunner = { getCurrentStep: () => ({ routineId: "r", revision: 1, stepIndex: 0, stepDigest: "a".repeat(64) }), advance: () => 1 };
  const controller = new TaskController({ store, planner: plannerFor([go()]), browser, approve: allow, hostVerifier: () => true, permissionMode: "full",
    routineRunner, routineRun: { routineId: "r", revision: 1, digest: "d", cursor: 0 } });
  const original = controller._denyRoutineStep.bind(controller);
  controller._denyRoutineStep = async (decision) => { denied.push(decision); return original(decision); };
  await controller.start();
  assert.deepEqual(browser.calls, []);
  assert.equal(denied.length, 1);
  assert.deepEqual(denied[0].reasons, ["lock_action_denied"]);
  assert.equal(controller.getSnapshot().pauseReason, "routine_step_denied");
  await store.close();
});

test("a mode-denied action still asks the approver, then waits for the user as a widened request", async () => {
  const store = await makeStore();
  const browser = fakeBrowser();
  const controller = new TaskController({ store, planner: plannerFor([go()]), browser, approve: allow, hostVerifier: () => true, permissionMode: "observe" });
  await controller.start();
  const [item] = controller.getSnapshot().approvalQueue;
  assert.equal(controller.getSnapshot().state, "awaiting_approval");
  assert.equal(item.widen, true);
  assert.deepEqual(item.leaseOffer, { action: "navigate", origin: "https://github.com" });
  await controller.approve(item.id);
  assert.deepEqual(browser.calls, [{ type: "navigate", widenedBy: { kind: "user_once", origin: "https://github.com" } }]);
  await store.close();
});

test("a mode-allowed action keeps its plain flow and passes no grant", async () => {
  const store = await makeStore();
  const browser = fakeBrowser();
  const controller = new TaskController({ store, planner: plannerFor([go()]), browser, approve: allow, hostVerifier: () => true, permissionMode: "browse" });
  await controller.start();
  assert.deepEqual(browser.calls, [{ type: "navigate", widenedBy: null }]);
  assert.deepEqual(controller.getSnapshot().leases, []);
  await store.close();
});

test("the approver's deny is never widened or leased", async () => {
  const store = await makeStore();
  const browser = fakeBrowser();
  const controller = new TaskController({ store, planner: plannerFor([go()]), browser, approve: deny, hostVerifier: () => true, permissionMode: "observe" });
  await controller.start();
  assert.deepEqual(controller.getSnapshot().approvalQueue, []);
  assert.deepEqual(browser.calls, []);
  await store.close();
});

test("unsupported and unattended mode-denied actions are skipped as before", async () => {
  const store = await makeStore();
  const browser = fakeBrowser();
  const click = { type: "click", elementId: "1" };
  const controller = new TaskController({ store, planner: plannerFor([click]), browser, approve: allow, hostVerifier: () => true, permissionMode: "observe" });
  await controller.start();
  assert.deepEqual(controller.getSnapshot().approvalQueue, []);
  const store2 = await makeStore();
  const unattended = new TaskController({ store: store2, planner: plannerFor([go()]), browser: fakeBrowser(), approve: allow, hostVerifier: () => true, permissionMode: "observe", reviewFallback: "deny" });
  await unattended.start();
  assert.deepEqual(unattended.getSnapshot().approvalQueue, []);
  await store.close();
  await store2.close();
});

test("Lend approves the request and covers the next matching actions until its uses run out", async () => {
  const store = await makeStore();
  const browser = fakeBrowser();
  const clock = clockAt(1_000_000);
  const controller = new TaskController({ store, planner: plannerFor([go("https://github.com/1")], [go("https://github.com/2")], [go("https://github.com/3")]), browser, approve: allow, hostVerifier: () => true, permissionMode: "observe", now: clock.now });
  await controller.start();
  const [first] = controller.getSnapshot().approvalQueue;
  await controller.lend(first.id, { minutes: 5, uses: 2 });
  // uses: 1 for the lent request, 1 for the next proposal; the third waits for the user again.
  assert.equal(browser.calls.length, 2);
  assert.ok(browser.calls.every((c) => c.widenedBy.kind === "lease"));
  assert.equal(controller.getSnapshot().state, "awaiting_approval");
  assert.deepEqual(controller.getSnapshot().leases, []);
  const types = (await store.getEvents()).map((e) => e.type).filter((t) => t.startsWith("lease_"));
  assert.deepEqual(types, ["lease_granted", "lease_used", "lease_used"]);
  await store.close();
});

test("a lease that expires while the approver thinks never runs the action", async () => {
  const store = await makeStore();
  const browser = fakeBrowser();
  const clock = clockAt(1_000_000);
  // Each approver call takes 61 s of controller time; the lease lasts 1 min.
  const slowAllow = async () => { clock.t += 61_000; return { decision: "allow", reasons: [] }; };
  const controller = new TaskController({ store, planner: plannerFor([go()], [go()]), browser, approve: slowAllow, hostVerifier: () => true, permissionMode: "observe", now: clock.now, monotonicNow: clock.now });
  await controller.start();
  await controller.lend(controller.getSnapshot().approvalQueue[0].id, { minutes: 1, uses: 3 });
  assert.equal(browser.calls.length, 1, "only the lent request ran");
  assert.equal(controller.getSnapshot().state, "awaiting_approval", "the second action waits for the user");
  assert.deepEqual(controller.getSnapshot().leases, []);
  const used = (await store.getEvents()).filter((e) => e.type === "lease_used");
  assert.equal(used.length, 1);
  await store.close();
});

test("a lease expires on monotonic time even if the system wall clock moves backwards", async () => {
  const store = await makeStore();
  const wall = clockAt(5_000_000);
  const monotonic = clockAt(10_000);
  const browser = fakeBrowser();
  const realExecute = browser.execute.bind(browser);
  browser.execute = async (action, options) => {
    const result = await realExecute(action, options);
    if (browser.calls.length === 1) {
      wall.t -= 60 * 60_000;
      monotonic.t += 61_000;
    }
    return result;
  };
  const controller = new TaskController({
    store,
    planner: plannerFor([go("https://github.com/1")], [go("https://github.com/2")]),
    browser,
    approve: allow,
    hostVerifier: () => true,
    permissionMode: "observe",
    now: wall.now,
    monotonicNow: monotonic.now,
  });

  await controller.start();
  await controller.lend(controller.getSnapshot().approvalQueue[0].id, { minutes: 1, uses: 3 });

  assert.equal(browser.calls.length, 1, "expired permission must not execute after wall-clock rollback");
  assert.equal(controller.getSnapshot().state, "awaiting_approval");
  assert.deepEqual(controller.getSnapshot().leases, []);
  await store.close();
});

test("an approval binding cannot be extended by a system wall-clock rollback", async () => {
  const store = await makeStore();
  const wall = clockAt(5_000_000);
  const monotonic = clockAt(10_000);
  const browser = fakeBrowser();
  const controller = new TaskController({
    store,
    planner: plannerFor([go()]),
    browser,
    approve: allow,
    hostVerifier: () => true,
    permissionMode: "observe",
    now: wall.now,
    monotonicNow: monotonic.now,
  });

  await controller.start();
  const [request] = controller.getSnapshot().approvalQueue;
  wall.t -= 60 * 60_000;
  monotonic.t += 61_000;
  await controller.approve(request.id);

  assert.deepEqual(browser.calls, [], "expired approval must not dispatch after wall-clock rollback");
  assert.equal(controller.getSnapshot().approvalQueue.length, 0);
  await store.close();
});

test("lend rejects bad terms and items without an offer; revoke and amend end leases", async () => {
  const store = await makeStore();
  const browser = fakeBrowser();
  // The second proposal targets another origin, so the task stays open (awaiting the user) after the lent one runs.
  const controller = new TaskController({ store, planner: plannerFor([go()], [go("https://other.test/")]), browser, approve: allow, hostVerifier: () => true, permissionMode: "observe" });
  await controller.start();
  const [item] = controller.getSnapshot().approvalQueue;
  await assert.rejects(controller.lend(item.id, { minutes: 30 }), (e) => e instanceof TaskControllerError && e.code === "invalid_lease_terms");
  await assert.rejects(controller.lend(item.id, "lots"), (e) => e instanceof TaskControllerError && e.code === "invalid_lease_terms");
  await assert.rejects(controller.lend("nope"), (e) => e instanceof TaskControllerError && e.code === "lease_unavailable");
  await controller.lend(item.id, { minutes: 10, uses: 3 });
  const [lease] = controller.getSnapshot().leases;
  assert.equal(lease.usesLeft, 2);
  await controller.revokeLease(lease.id);
  assert.deepEqual(controller.getSnapshot().leases, []);
  await store.close();

  const store2 = await makeStore();
  const browser2 = fakeBrowser();
  const ctl2 = new TaskController({ store: store2, planner: plannerFor([go()], [go("https://other.test/")]), browser: browser2, approve: allow, hostVerifier: () => true, permissionMode: "observe" });
  await ctl2.start();
  await ctl2.lend(ctl2.getSnapshot().approvalQueue[0].id, null);
  assert.equal(ctl2.getSnapshot().leases.length, 1);
  await ctl2.amend({ text: "change of plan", lock: { rules: [{ kind: "deny_action", action: "click" }] } });
  assert.deepEqual(ctl2.getSnapshot().leases, []);
  assert.equal(browser2.lock.rules[0].action, "click", "amend pushes the new lock to the browser");
  const revoked = (await store2.getEvents()).filter((e) => e.type === "lease_revoked");
  assert.equal(revoked[0].payload.reason, "goal_amended");
  await store2.close();
});

test("a failed user lease revocation can be retried until the journal records it", async () => {
  const store = await makeStore();
  const controller = new TaskController({ store, planner: plannerFor([go()], [go("https://other.test/")]), browser: fakeBrowser(), approve: allow, hostVerifier: () => true, permissionMode: "observe" });
  await controller.start();
  await controller.lend(controller.getSnapshot().approvalQueue[0].id, null);
  const lease = controller.getSnapshot().leases[0];
  const append = store.append.bind(store);
  let rejectFirstRevocation = true;
  store.append = async (event, options) => {
    if (event.type === "lease_revoked" && rejectFirstRevocation) {
      rejectFirstRevocation = false;
      throw new Error("injected journal write failure");
    }
    return append(event, options);
  };

  await assert.rejects(controller.revokeLease(lease.id), /injected journal write failure/);
  await controller.revokeLease(lease.id);

  assert.deepEqual((await leasedEvents(store)).map((event) => event.type), ["lease_granted", "lease_used", "lease_revoked"]);
  assert.deepEqual(controller.getSnapshot().leases, []);
  await store.close();
});

const { createLease } = require("../main/harness/capability-lease");
const { randomUUID } = require("node:crypto");

test("snapshot pruning bounds long-lived lease state but retains unrecorded revocations", async () => {
  const store = await makeStore();
  const clock = clockAt(20_000);
  const controller = new TaskController({
    store,
    planner: plannerFor(),
    browser: fakeBrowser(),
    approve: allow,
    hostVerifier: () => true,
    monotonicNow: clock.now,
  });
  controller._leases.push(...Array.from({ length: 100 }, (_, index) => createLease({
    id: `expired-${index}`,
    taskId: store.taskId,
    action: "navigate",
    origin: "https://github.com",
    now: 0,
    minutes: 1,
    uses: 1,
  })));
  controller._leases.push(createLease({ id: "exhausted", taskId: store.taskId, action: "navigate", origin: "https://github.com", now: clock.now(), minutes: 1, uses: 1 }));
  controller._leases.at(-1).usesLeft = 0;
  controller._leases.push({ ...createLease({ id: "revocation-pending", taskId: store.taskId, action: "navigate", origin: "https://github.com", now: 0, minutes: 1, uses: 1 }), revoked: true, revocationRecorded: false });
  clock.t += 61_000;

  assert.deepEqual(controller.getSnapshot().leases, []);
  assert.deepEqual(controller._leases.map((lease) => lease.id), ["revocation-pending"], "only an unrecorded revoke remains retryable");
  await store.close();
});

async function leasedEvents(store) {
  return (await store.getEvents()).filter((e) => e.type.startsWith("lease_"));
}

test("I1: a pause between the grant and the approval leaves no live lease, and one request earns one lease", async () => {
  const store = await makeStore();
  const browser = fakeBrowser();
  const controller = new TaskController({ store, planner: plannerFor([go()]), browser, approve: allow, hostVerifier: () => true, permissionMode: "observe" });
  await controller.start();
  const [item] = controller.getSnapshot().approvalQueue;
  let pausing = null;
  const append = store.append.bind(store);
  store.append = async (event, opts) => {
    const result = await append(event, opts);
    if (event.type === "lease_granted" && !pausing) pausing = controller.pause();
    return result;
  };
  const first = controller.lend(item.id);
  await assert.rejects(controller.lend(item.id), (e) => e instanceof TaskControllerError && e.code === "lease_unavailable", "a concurrent lend on the same request is refused");
  await assert.rejects(first, (e) => e instanceof TaskControllerError && e.code === "admission_closed");
  await pausing;
  assert.deepEqual(browser.calls, []);
  assert.deepEqual(controller.getSnapshot().leases, []);
  const events = await leasedEvents(store);
  assert.deepEqual(events.map((e) => e.type), ["lease_granted", "lease_revoked"]);
  assert.equal(events[1].payload.reason, "request_stale");
  await store.close();
});

test("I2: takeOver and stop revoke every live lease", async () => {
  for (const [end, reason] of [["takeOver", "taken_over"], ["stop", "task_ended"]]) {
    const store = await makeStore();
    const controller = new TaskController({ store, planner: plannerFor([go()], [go("https://other.test/")]), browser: fakeBrowser(), approve: allow, hostVerifier: () => true, permissionMode: "observe" });
    await controller.start();
    await controller.lend(controller.getSnapshot().approvalQueue[0].id);
    assert.equal(controller.getSnapshot().leases.length, 1);
    await controller[end]();
    assert.deepEqual(controller.getSnapshot().leases, []);
    assert.equal(controller._leases.filter((l) => !l.revoked).length, 0, `${end} marks the lease revoked`);
    const revoked = (await store.getEvents()).filter((e) => e.type === "lease_revoked");
    assert.deepEqual(revoked.map((e) => e.payload.reason), [reason]);
    await store.close();
  }
});

test("I3: two simultaneous uses of a one-use lease spend it once; a lease revoked mid-record runs nothing", async () => {
  const store = await makeStore();
  const controller = new TaskController({ store, planner: plannerFor(), browser: fakeBrowser(), approve: allow, hostVerifier: () => true, permissionMode: "observe" });
  const lease = createLease({ id: randomUUID(), taskId: "t", action: "navigate", origin: "https://github.com", now: monotonicNow(), minutes: 5, uses: 1 });
  controller._leases.push(lease);
  const results = await Promise.all([controller._useLease(lease, randomUUID()), controller._useLease(lease, randomUUID())]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(lease.usesLeft, 0);
  assert.equal((await store.getEvents()).filter((e) => e.type === "lease_used").length, 1);

  const lease2 = createLease({ id: randomUUID(), taskId: "t", action: "navigate", origin: "https://github.com", now: monotonicNow(), minutes: 5, uses: 3 });
  const append = store.append.bind(store);
  store.append = async (event, opts) => {
    const result = await append(event, opts);
    if (event.type === "lease_used") lease2.revoked = true;
    return result;
  };
  assert.equal(await controller._useLease(lease2, randomUUID()), null);
  assert.equal(lease2.usesLeft, 2, "the reserved use stays spent");
  await store.close();
});

test("a lease expiring during durable use recording returns the action to human review", async () => {
  const store = await makeStore();
  const monotonic = clockAt(10_000);
  const wall = clockAt(5_000_000);
  const browser = fakeBrowser();
  const controller = new TaskController({
    store,
    planner: plannerFor([go("https://github.com/1")], [go("https://github.com/2")]),
    browser,
    approve: allow,
    hostVerifier: () => true,
    permissionMode: "observe",
    now: wall.now,
    monotonicNow: monotonic.now,
  });
  let releaseRecord;
  let enteredRecord;
  let usedRecords = 0;
  const recordGate = new Promise((resolve) => { releaseRecord = resolve; });
  const recordStarted = new Promise((resolve) => { enteredRecord = resolve; });
  const append = store.append.bind(store);
  store.append = async (event, options) => {
    if (event.type === "lease_used" && ++usedRecords === 2) {
      enteredRecord();
      await recordGate;
    }
    return append(event, options);
  };

  await controller.start();
  const pendingLend = controller.lend(controller.getSnapshot().approvalQueue[0].id, { minutes: 1, uses: 3 });
  await recordStarted;
  monotonic.t += 61_000;
  releaseRecord();
  await pendingLend;

  assert.equal(browser.calls.length, 1, "the action whose lease expired during recording must not dispatch");
  assert.equal(controller.getSnapshot().state, "awaiting_approval");
  assert.equal(controller.getSnapshot().approvalQueue.length, 1);
  assert.deepEqual(controller.getSnapshot().leases, []);
  assert.equal((await store.getEvents()).filter((event) => event.type === "lease_used").length, 2, "both recorded reservations remain spent");
  await store.close();
});

test("a task stop drains an in-flight user lease revocation before its terminal checkpoint", async () => {
  const store = await makeStore();
  const controller = new TaskController({ store, planner: plannerFor([go()], [go("https://other.test/")]), browser: fakeBrowser(), approve: allow, hostVerifier: () => true, permissionMode: "observe" });
  await controller.start();
  await controller.lend(controller.getSnapshot().approvalQueue[0].id);
  const lease = controller.getSnapshot().leases[0];

  let releaseRevoke;
  let enteredRevoke;
  const revokeEntered = new Promise((resolve) => { enteredRevoke = resolve; });
  const revokeGate = new Promise((resolve) => { releaseRevoke = resolve; });
  const append = store.append.bind(store);
  store.append = async (event, options) => {
    if (event.type === "lease_revoked" && event.payload.reason === "user") {
      enteredRevoke();
      await revokeGate;
    }
    return append(event, options);
  };

  let revoking;
  let stopping;
  try {
    revoking = controller.revokeLease(lease.id);
    await revokeEntered;
    let stopped = false;
    stopping = controller.stop().then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(stopped, false, "stop waits for the already-admitted durable lease write");
    releaseRevoke();
    await Promise.all([revoking, stopping]);
    assert.equal(controller.getSnapshot().state, "stopped");
    const events = await leasedEvents(store);
    assert.deepEqual(events.map((event) => event.type), ["lease_granted", "lease_used", "lease_revoked"]);
  } finally {
    releaseRevoke();
    await Promise.allSettled([revoking, stopping]);
    await store.close();
  }
});

test("stop during lease grant durably revokes the grant before returning", async () => {
  const store = await makeStore();
  const controller = new TaskController({ store, planner: plannerFor([go()]), browser: fakeBrowser(), approve: allow, hostVerifier: () => true, permissionMode: "observe" });
  await controller.start();
  const requestId = controller.getSnapshot().approvalQueue[0].id;
  let releaseGrant;
  let enteredGrant;
  const grantEntered = new Promise((resolve) => { enteredGrant = resolve; });
  const grantGate = new Promise((resolve) => { releaseGrant = resolve; });
  let releaseRevoke;
  let enteredRevoke;
  const revokeEntered = new Promise((resolve) => { enteredRevoke = resolve; });
  const revokeGate = new Promise((resolve) => { releaseRevoke = resolve; });
  const append = store.append.bind(store);
  let stopping;
  store.append = async (event, options) => {
    if (event.type === "lease_granted") {
      const result = await append(event, options);
      stopping = controller.stop();
      enteredGrant();
      await grantGate;
      return result;
    }
    if (event.type === "lease_revoked") {
      enteredRevoke();
      await revokeGate;
    }
    return append(event, options);
  };

  let lending;
  try {
    lending = controller.lend(requestId).then(() => null, (error) => error);
    await grantEntered;
    releaseGrant();
    await revokeEntered;
    let stopped = false;
    stopping = stopping.then(() => { stopped = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(stopped, false, "stop drains the revocation that follows its in-flight grant");
    releaseRevoke();
    await stopping;
    const events = await leasedEvents(store);
    assert.deepEqual(events.map((event) => event.type), ["lease_granted", "lease_revoked"]);
    assert.deepEqual(controller.getSnapshot().leases, []);
    assert.equal((await lending)?.code, "admission_closed");
  } finally {
    releaseGrant();
    releaseRevoke();
    await Promise.allSettled([lending, stopping]);
    await store.close();
  }
});

test("I4: in interact mode a leased click still needs the approver's allow; deny or review never spends the lease", async () => {
  for (const [verdict, expectRun, expectQueued] of [["deny", false, false], ["review", false, true], ["allow", true, false]]) {
    const store = await makeStore();
    const browser = fakeBrowser();
    browser.supportsAction = (type) => type === "click" || type === "navigate"; // a browser that can click, like the real one
    browser.observe = async () => ({ id: "obs", url: "https://page.test/", elements: [{ elementId: "1", tag: "button" }] });
    let approverCalls = 0;
    const click ={ type: "click", elementId: "1" };
    const controller = new TaskController({ store, planner: plannerFor([click]), browser, approve: async () => { approverCalls += 1; return { decision: verdict, reasons: [] }; }, hostVerifier: () => true, permissionMode: "interact" });
    const lease = createLease({ id: randomUUID(), taskId: "t", action: "click", origin: "https://page.test", now: monotonicNow(), minutes: 5, uses: 3 });
    controller._leases.push(lease);
    await controller.start();
    assert.equal(approverCalls, 1, verdict);
    assert.equal(browser.calls.length, expectRun ? 1 : 0, verdict);
    if (expectRun) assert.deepEqual(browser.calls[0].widenedBy, { kind: "lease", leaseId: lease.id, origin: "https://page.test" });
    assert.equal(lease.usesLeft, expectRun ? 2 : 3, verdict);
    assert.equal(controller.getSnapshot().approvalQueue.length, expectQueued ? 1 : 0, verdict);
    await store.close();
  }
});

test("M2: an unattended run never spends a lease", async () => {
  const store = await makeStore();
  const browser = fakeBrowser();
  const controller = new TaskController({ store, planner: plannerFor([{ type: "click", elementId: "1" }]), browser, approve: allow, hostVerifier: () => true, permissionMode: "interact", reviewFallback: "deny" });
  const lease = createLease({ id: randomUUID(), taskId: "t", action: "click", origin: "https://page.test", now: monotonicNow(), minutes: 5, uses: 3 });
  controller._leases.push(lease);
  await controller.start();
  assert.deepEqual(browser.calls, []);
  assert.equal(lease.usesLeft, 3);
  await store.close();
});

test("I3: no lease is offered for an action the browser cannot (or may not be able to) run", async () => {
  // interact mode: click is a human review; the fake browser cannot click.
  const store = await makeStore();
  const controller = new TaskController({ store, planner: plannerFor([{ type: "click", elementId: "1" }]), browser: fakeBrowser(), approve: allow, hostVerifier: () => true, permissionMode: "interact" });
  await controller.start();
  const [item] = controller.getSnapshot().approvalQueue;
  assert.equal(item.action, "click");
  assert.equal(item.leaseOffer, null);
  await assert.rejects(controller.lend(item.id), (e) => e instanceof TaskControllerError && e.code === "lease_unavailable");
  await store.close();

  // A browser that cannot say what it supports is not offered a lease either.
  const store2 = await makeStore();
  const { supportsAction, ...silent } = fakeBrowser();
  void supportsAction;
  const ctl2 = new TaskController({ store: store2, planner: plannerFor([go()]), browser: silent, approve: allow, hostVerifier: () => true, permissionMode: "observe" });
  await ctl2.start();
  assert.equal(ctl2.getSnapshot().approvalQueue[0].leaseOffer, null);
  await store2.close();
});

test("completion revokes every live lease and the completed snapshot shows none", async () => {
  const store = await makeStore({ criteria: [{ id: "C1", text: "visited", required: true, verification: "host" }] });
  const browser = fakeBrowser();
  browser.execute = async (action) => ({ status: "ok", evidenceCandidate: { kind: "host_check", sourceUrl: action.url } });
  let calls = 0;
  const planner = { next: async (context) => {
    calls += 1;
    const base = { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation?.id ?? "obs", criterionIds: ["C1"] };
    return calls === 1 ? { ...base, kind: "actions", actions: [go()] } : { ...base, kind: "finish", evidenceIds: [] };
  } };
  const controller = new TaskController({ store, planner, browser, approve: allow, hostVerifier: () => true, permissionMode: "observe" });
  await controller.start();
  await controller.lend(controller.getSnapshot().approvalQueue[0].id);
  assert.equal(controller.getSnapshot().state, "completed");
  assert.deepEqual(controller.getSnapshot().leases, []);
  const revoked = (await store.getEvents()).filter((e) => e.type === "lease_revoked");
  assert.deepEqual(revoked.map((e) => e.payload.reason), ["task_ended"]);
  await store.close();
});

test("I2: lease and Allow-once grants carry the origin the user saw", async () => {
  const store = await makeStore();
  const browser = fakeBrowser();
  const controller = new TaskController({ store, planner: plannerFor([go("https://github.com/1")], [go("https://github.com/2")], [go("https://other.test/")]), browser, approve: allow, hostVerifier: () => true, permissionMode: "observe" });
  await controller.start();
  await controller.lend(controller.getSnapshot().approvalQueue[0].id);
  await controller.approve(controller.getSnapshot().approvalQueue[0].id);
  assert.deepEqual(browser.calls.map((c) => c.widenedBy.origin), ["https://github.com", "https://github.com", "https://other.test"]);
  assert.deepEqual(browser.calls.map((c) => c.widenedBy.kind), ["lease", "lease", "user_once"]);
  await store.close();
});
