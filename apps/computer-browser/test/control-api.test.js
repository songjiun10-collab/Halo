"use strict";

// Regression tests for the stopTask()/pauseTask() race found while
// coordinating with Codex on apps/computer-browser: an approver round-trip
// already in flight when stopTask()/pauseTask() ran used to ignore the new
// state entirely once it resolved -- a late "allow" executed anyway, and a
// late "review" re-populated the queue stopTask() had just cleared. These
// tests exercise ControlApi directly (no Electron, no real socket) via the
// requestDecision injection seam in the constructor, so they can control
// exactly when the decision resolves relative to stop/pause.

const test = require("node:test");
const assert = require("node:assert/strict");
const { ControlApi } = require("../main/control-api");

function deferredDecision() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeApi(requestDecisionStub, options = {}) {
  const api = new ControlApi({
    window: {},
    socketPath: "/tmp/fake.sock",
    requestDecision: requestDecisionStub,
    // 0 by default so unrelated tests never trip over the real pacing floor
    // (MIN_AGENT_ACTION_INTERVAL_MS) -- pacing itself is exercised by tests
    // further down that explicitly pass a small nonzero interval.
    minAgentActionIntervalMs: 0,
    ...options,
  });
  api._task = { id: "t1", state: "running", pauseReason: null };
  return api;
}

// A manually-advanced clock for deterministic latency-metric assertions --
// no real sleeping, no timing tolerance windows.
function makeFakeClock(startAt = 0) {
  let current = startAt;
  return { now: () => current, advance: (ms) => { current += ms; } };
}

// Minimal fake WebContentsView for the handful of tests that exercise the
// real navigate()/_findFirstOutboundLink() bodies (navigation timeout, DOM
// scan cap) rather than replacing them with a mock closure. Assigning this
// directly to api._view makes _ensureView() a no-op (it only constructs a
// real WebContentsView when this._view is falsy), so these tests never
// touch Electron.
function makeFakeView({ loadURL, executeJavaScript, stop } = {}) {
  return {
    webContents: {
      loadURL: loadURL || (async () => {}),
      stop: stop || (() => {}),
      executeJavaScript: executeJavaScript || (async () => null),
      navigationHistory: { canGoBack: () => false, canGoForward: () => false },
      on: () => {},
    },
    setVisible: () => {},
    setBounds: () => {},
  };
}

test("performGatedAction executes immediately on allow (baseline, no stop/pause)", async () => {
  const api = makeApi(async () => ({ decision: "allow", reasons: [] }));
  let executed = false;
  const outcome = await api.performGatedAction(
    { requestId: "r1", action: "navigate", summary: "go" },
    async () => {
      executed = true;
    },
  );
  assert.equal(outcome, "allow");
  assert.equal(executed, true);
});

test("performGatedAction queues review (baseline, no stop/pause)", async () => {
  const api = makeApi(async () => ({ decision: "review", reasons: ["why"] }));
  const outcome = await api.performGatedAction(
    { requestId: "r1", action: "navigate", summary: "go" },
    async () => {},
  );
  assert.equal(outcome, "review");
  const snapshot = api.getSnapshot();
  assert.equal(snapshot.approvalQueue.length, 1);
  assert.equal(snapshot.task.state, "awaiting_approval");
});

test("stopTask discards a late allow instead of executing it", async () => {
  const { promise, resolve } = deferredDecision();
  const api = makeApi(async () => promise);

  let executed = false;
  const pending = api.performGatedAction(
    { requestId: "r1", action: "navigate", summary: "go" },
    async () => {
      executed = true;
    },
  );

  await api.stopTask();
  resolve({ decision: "allow", reasons: [] });

  const outcome = await pending;
  assert.equal(outcome, "cancelled");
  assert.equal(executed, false, "a decision that arrives after stop must never execute");
  assert.equal(api.getSnapshot().task.state, "stopped", "the late decision must not overwrite the stopped state");
});

test("stopTask discards a late review without resurrecting the approval queue", async () => {
  const { promise, resolve } = deferredDecision();
  const api = makeApi(async () => promise);

  const pending = api.performGatedAction(
    { requestId: "r1", action: "navigate", summary: "go" },
    async () => {},
  );

  await api.stopTask();
  resolve({ decision: "review", reasons: ["needs a human"] });

  const outcome = await pending;
  assert.equal(outcome, "cancelled");
  const snapshot = api.getSnapshot();
  assert.equal(snapshot.approvalQueue.length, 0, "stop must not be silently undone by a late review");
  assert.equal(snapshot.task.state, "stopped");
});

test("pauseTask holds a late allow instead of executing it; resumeTask applies it", async () => {
  const { promise, resolve } = deferredDecision();
  const api = makeApi(async () => promise);

  let executed = false;
  const pending = api.performGatedAction(
    { requestId: "r1", action: "navigate", summary: "go" },
    async () => {
      executed = true;
    },
  );

  await api.pauseTask();
  resolve({ decision: "allow", reasons: [] });

  const outcome = await pending;
  assert.equal(outcome, "paused");
  assert.equal(executed, false, "a decision that arrives while paused must not execute immediately");
  assert.equal(api.getSnapshot().task.state, "paused");

  await api.resumeTask();
  assert.equal(executed, true, "resumeTask must apply the held decision");
  assert.equal(api.getSnapshot().task.state, "completed");
});

test("pauseTask holds a late review; resumeTask queues it for approval", async () => {
  const { promise, resolve } = deferredDecision();
  const api = makeApi(async () => promise);

  const pending = api.performGatedAction(
    { requestId: "r1", action: "navigate", summary: "go" },
    async () => {},
  );

  await api.pauseTask();
  resolve({ decision: "review", reasons: ["needs a human"] });

  const outcome = await pending;
  assert.equal(outcome, "paused");
  assert.equal(api.getSnapshot().approvalQueue.length, 0, "must not queue while still paused");

  await api.resumeTask();
  const snapshot = api.getSnapshot();
  assert.equal(snapshot.approvalQueue.length, 1);
  assert.equal(snapshot.task.state, "awaiting_approval");
});

// Independently reproduced and reported by Codex: the fix above only guards
// the window *before* execute() runs (waiting on the approver). It missed
// stopTask() landing *while an already-approved* execute() is still in
// flight (e.g. a real navigate() awaiting loadURL()) -- in that case the
// decision was legitimately "allow" and execute() genuinely ran, but every
// caller that turns "allow" into `_task.state = "completed"` was still doing
// so unconditionally, silently overwriting the "stopped" state stopTask()
// had already set. Fixed by threading the captured epoch into
// _applyDecision() and re-checking it after execute() resolves, and by
// capturing one epoch at the top of startTask() and re-checking it at every
// subsequent await (including the previously-unchecked _findFirstOutboundLink
// await and its "no link found" branch, which is exactly what this repro
// hits).

test("performGatedAction reports a stale allow (but still runs execute()) if stopTask() lands mid-execute", async () => {
  const api = makeApi(async () => ({ decision: "allow", reasons: [] }));
  let resolveExecute;
  const executePromise = new Promise((res) => {
    resolveExecute = res;
  });
  let executed = false;

  const pending = api.performGatedAction(
    { requestId: "r1", action: "navigate", summary: "go" },
    async () => {
      await executePromise;
      executed = true;
    },
  );

  // Let performGatedAction actually reach the awaited execute() call before
  // stopping -- otherwise stopTask()'s synchronous epoch bump (it has no
  // internal await) would land before performGatedAction's very first
  // continuation ever runs, catching it at the pre-execute check instead of
  // the one this test targets.
  await new Promise((r) => setImmediate(r));
  await api.stopTask();
  resolveExecute();

  const outcome = await pending;
  assert.equal(outcome, "cancelled", "the caller must not be told this was a clean allow once stop happened mid-flight");
  assert.equal(executed, true, "execute() already genuinely ran; this guard is about not misreporting the outcome afterwards");
  assert.equal(api.getSnapshot().task.state, "stopped");
});

test("startTask leaves the task stopped, not completed, if stopTask() lands while step 1's navigate is still running", async () => {
  const api = makeApi(async () => ({ decision: "allow", reasons: [] }));
  let resolveNavigate;
  const navigatePromise = new Promise((res) => {
    resolveNavigate = res;
  });
  api.navigate = async () => {
    await navigatePromise;
  };
  api._findFirstOutboundLink = async () => null;

  const pending = api.startTask("https://example.com");
  await new Promise((r) => setImmediate(r));
  await api.stopTask();
  resolveNavigate();
  await pending;

  assert.equal(api.getSnapshot().task.state, "stopped");
});

test("resumeTask leaves the task stopped, not completed, if stopTask() lands while the held decision's execute() is still running", async () => {
  const { promise, resolve } = deferredDecision();
  const api = makeApi(async () => promise);

  let resolveExecute;
  const executePromise = new Promise((res) => {
    resolveExecute = res;
  });
  const pending = api.performGatedAction(
    { requestId: "r1", action: "navigate", summary: "go" },
    async () => {
      await executePromise;
    },
  );

  await api.pauseTask();
  resolve({ decision: "allow", reasons: [] });
  await pending; // now "paused" with the decision held, execute() not yet called

  const resumePending = api.resumeTask();
  await new Promise((r) => setImmediate(r));
  await api.stopTask();
  resolveExecute();
  await resumePending;

  assert.equal(api.getSnapshot().task.state, "stopped");
});

test("approve leaves the task stopped, not completed, if stopTask() lands while the approved item's execute() is still running", async () => {
  const api = makeApi(async () => ({ decision: "review", reasons: ["needs a human"] }));
  let resolveExecute;
  const executePromise = new Promise((res) => {
    resolveExecute = res;
  });

  await api.performGatedAction(
    { requestId: "r1", action: "navigate", summary: "go" },
    async () => {
      await executePromise;
    },
  );
  assert.equal(api.getSnapshot().approvalQueue.length, 1);

  const approvePending = api.approve("r1");
  await new Promise((r) => setImmediate(r));
  await api.stopTask();
  resolveExecute();
  await approvePending;

  assert.equal(api.getSnapshot().task.state, "stopped");
  assert.equal(api.getSnapshot().approvalQueue.length, 0);
});

test("stopTask after pause discards the held decision too", async () => {
  const { promise, resolve } = deferredDecision();
  const api = makeApi(async () => promise);

  let executed = false;
  const pending = api.performGatedAction(
    { requestId: "r1", action: "navigate", summary: "go" },
    async () => {
      executed = true;
    },
  );

  await api.pauseTask();
  resolve({ decision: "allow", reasons: [] });
  await pending; // now "paused" with a deferred decision held

  await api.stopTask();
  await api.resumeTask(); // must be a no-op: task is "stopped", not "paused"

  assert.equal(executed, false);
  assert.equal(api.getSnapshot().task.state, "stopped");
});

// --- Pacing floor for agent-initiated actions (requested to reduce how
// often automated browsing trips a site's CAPTCHA/rate-limit heuristics --
// pure request pacing, never detection bypass or fingerprint spoofing). ---

test("paces a second agent-initiated allow, but never the first", async () => {
  const api = makeApi(async () => ({ decision: "allow", reasons: [] }), { minAgentActionIntervalMs: 40 });
  const timestamps = [];
  const execute = async () => {
    timestamps.push(Date.now());
  };

  const start = Date.now();
  await api.performGatedAction({ requestId: "r1", action: "navigate", summary: "go" }, execute);
  assert.ok(timestamps[0] - start < 20, "the very first agent action must not wait for the pacing floor");

  await api.performGatedAction({ requestId: "r2", action: "navigate", summary: "go" }, execute);
  assert.ok(
    timestamps[1] - timestamps[0] >= 40,
    `expected at least a 40ms gap between consecutive agent actions, got ${timestamps[1] - timestamps[0]}ms`,
  );
});

test("approve() shares the same pacing clock as agent-initiated allows", async () => {
  const api = makeApi(async () => ({ decision: "allow", reasons: [] }), { minAgentActionIntervalMs: 40 });
  const firstAt = [];
  await api.performGatedAction({ requestId: "seed", action: "navigate", summary: "seed" }, async () => {
    firstAt.push(Date.now());
  });

  let approvedAt = null;
  api._approvalQueue.push({
    id: "r2",
    summary: "go",
    origin: "",
    action: "navigate",
    reason: "test",
    createdAt: new Date().toISOString(),
    _execute: async () => {
      approvedAt = Date.now();
    },
  });
  await api.approve("r2");
  assert.ok(
    approvedAt - firstAt[0] >= 40,
    "approve() must respect the same pacing floor as an agent-initiated allow",
  );
});

// --- CAPTCHA handoff: detect (read-only heuristic), preserve state, pause,
// and require an explicit, re-checked human resume. Never solve, click
// through, or route around a challenge. ---

test("_syncPageState auto-pauses an active task when the page looks like a CAPTCHA", () => {
  const api = makeApi(async () => ({ decision: "allow", reasons: [] }));
  api._task = { id: "t1", state: "running", pauseReason: null };

  api._syncPageState({ url: "https://example.com/", title: "Just a moment..." });

  const snapshot = api.getSnapshot();
  assert.equal(snapshot.page.captchaSuspected, true);
  assert.equal(snapshot.task.state, "paused");
  assert.equal(snapshot.task.pauseReason, "captcha");
});

test("_syncPageState does not touch an idle/completed/stopped task even if the page looks like a CAPTCHA", () => {
  const api = makeApi(async () => ({ decision: "allow", reasons: [] }));
  api._task = { id: "t1", state: "completed", pauseReason: null };

  api._syncPageState({ url: "https://example.com/", title: "Just a moment..." });

  const snapshot = api.getSnapshot();
  assert.equal(snapshot.page.captchaSuspected, true, "the informational flag is always computed");
  assert.equal(snapshot.task.state, "completed", "nothing to preserve for a task that isn't active");
});

test("resumeTask() refuses a CAPTCHA-paused task and points at resumeAfterCaptcha()", async () => {
  const api = makeApi(async () => ({ decision: "allow", reasons: [] }));
  api._task = { id: "t1", state: "running", pauseReason: null };
  api._syncPageState({ url: "https://example.com/", title: "Just a moment..." });
  assert.equal(api.getSnapshot().task.state, "paused");

  await api.resumeTask();

  const snapshot = api.getSnapshot();
  assert.equal(snapshot.task.state, "paused", "resumeTask() must not resume a CAPTCHA-paused task");
  assert.equal(snapshot.task.pauseReason, "captcha");
});

test("resumeAfterCaptcha() refuses to resume while the page still looks like a CAPTCHA", async () => {
  const api = makeApi(async () => ({ decision: "allow", reasons: [] }));
  api._task = { id: "t1", state: "running", pauseReason: null };
  api._syncPageState({ url: "https://example.com/", title: "Just a moment..." });

  await api.resumeAfterCaptcha();

  const snapshot = api.getSnapshot();
  assert.equal(snapshot.task.state, "paused", "must stay paused -- no auto-retry while unresolved");
  assert.equal(snapshot.task.pauseReason, "captcha");
});

test("resumeAfterCaptcha() resumes once the page no longer looks like a CAPTCHA", async () => {
  const api = makeApi(async () => ({ decision: "allow", reasons: [] }));
  api._task = { id: "t1", state: "running", pauseReason: null };
  api._syncPageState({ url: "https://example.com/checkpoint", title: "Just a moment..." });
  assert.equal(api.getSnapshot().task.state, "paused");

  // The human solved it directly in the browser; the page moved on.
  api._syncPageState({ url: "https://example.com/welcome", title: "Welcome" });
  // A plain page-state update while paused must not itself trigger a resume.
  assert.equal(api.getSnapshot().task.state, "paused");

  await api.resumeAfterCaptcha();

  const snapshot = api.getSnapshot();
  assert.equal(snapshot.task.state, "running");
  assert.equal(snapshot.task.pauseReason, null);
});

test("resumeAfterCaptcha() is a no-op when the task isn't CAPTCHA-paused", async () => {
  const api = makeApi(async () => ({ decision: "allow", reasons: [] }));
  api._task = { id: "t1", state: "running", pauseReason: null };

  await api.resumeAfterCaptcha();

  assert.equal(api.getSnapshot().task.state, "running");
});

test("a CAPTCHA detected while an already-approved execute() is running pauses instead of completing the task", async () => {
  // Simulates a real navigate() whose did-navigate handler calls
  // _syncPageState() with the challenge page's url/title before loadURL()
  // itself resolves -- exactly the ordering a real WebContentsView produces.
  const api = makeApi(async () => ({ decision: "allow", reasons: [] }));
  api._findFirstOutboundLink = async () => null;
  api.navigate = async () => {
    api._syncPageState({ url: "https://example.com/checkpoint", title: "Just a moment..." });
  };

  const snapshot = await api.startTask("https://example.com");

  assert.equal(snapshot.task.state, "paused");
  assert.equal(snapshot.task.pauseReason, "captcha");
});

// Independently flagged during review: an earlier version of
// resumeAfterCaptcha()/resumeTask() only flipped _task.state back to
// "running" without ever re-entering startTask()'s remaining steps -- a
// CAPTCHA-paused task would silently dead-end at "running" forever with no
// further navigation, review, or completion. These tests drive the
// continuation all the way through to prove it's a real resume, not just a
// state flip. See _taskCursor / _afterStepOutcome / _runStepTwo.

test("resumeAfterCaptcha() actually continues into step 2, not just flips the state to running", async () => {
  const api = makeApi(async () => ({ decision: "allow", reasons: [] }));
  let findLinkCalls = 0;
  api._findFirstOutboundLink = async () => {
    findLinkCalls += 1;
    return null; // no outbound link -> step 2 concludes the task on its own
  };
  api.navigate = async () => {
    if (findLinkCalls === 0) {
      // step 1's real navigate() triggers a CAPTCHA mid-flight, exactly like
      // a real did-navigate handler would report it.
      api._syncPageState({ url: "https://example.com/checkpoint", title: "Just a moment..." });
    }
  };

  const paused = await api.startTask("https://example.com");
  assert.equal(paused.task.state, "paused");
  assert.equal(paused.task.pauseReason, "captcha");
  assert.equal(findLinkCalls, 0, "step 2 must not have run yet");

  // The human solved it directly in the browser; the page moved on.
  api._syncPageState({ url: "https://example.com/welcome", title: "Welcome" });
  const resumed = await api.resumeAfterCaptcha();

  assert.equal(findLinkCalls, 1, "resuming must actually re-enter step 2, not just flip the state");
  assert.equal(resumed.task.state, "completed");
});

test("resumeAfterCaptcha() continues all the way into a real step-2 REVIEW after step 1 was CAPTCHA-paused", async () => {
  let decisionCall = 0;
  const api = makeApi(async () => {
    decisionCall += 1;
    // Step 1 (user_prompt) -> allow; step 2 (page_content) -> review,
    // matching how the real approver actually classifies these two sources.
    return decisionCall === 1
      ? { decision: "allow", reasons: [] }
      : { decision: "review", reasons: ["untrusted source"] };
  });
  let navigateCalls = 0;
  api._findFirstOutboundLink = async () => ({ href: "https://example.com/next", text: "Next" });
  api.navigate = async () => {
    navigateCalls += 1;
    if (navigateCalls === 1) {
      api._syncPageState({ url: "https://example.com/checkpoint", title: "Just a moment..." });
    }
  };

  const paused = await api.startTask("https://example.com");
  assert.equal(paused.task.state, "paused");

  api._syncPageState({ url: "https://example.com/welcome", title: "Welcome" });
  const resumed = await api.resumeAfterCaptcha();

  assert.equal(resumed.task.state, "awaiting_approval");
  assert.equal(resumed.approvalQueue.length, 1);
  assert.equal(resumed.approvalQueue[0].origin, "https://example.com/welcome");
});

test("resumeTask() continues into step 2 after step 1 was paused before its decision executed", async () => {
  const { promise, resolve } = deferredDecision();
  const api = makeApi(async () => promise);
  let executedStep1 = false;
  let findLinkCalls = 0;
  api._findFirstOutboundLink = async () => {
    findLinkCalls += 1;
    return null;
  };
  api.navigate = async () => {
    executedStep1 = true;
  };

  const startPromise = api.startTask("https://example.com");
  await new Promise((r) => setImmediate(r));
  await api.pauseTask();
  resolve({ decision: "allow", reasons: [] });
  const paused = await startPromise;

  assert.equal(paused.task.state, "paused");
  assert.equal(executedStep1, false, "the decision was held before its execute() ran");

  const resumed = await api.resumeTask();

  assert.equal(executedStep1, true);
  assert.equal(findLinkCalls, 1, "resuming a pre-execute pause of step 1 must still continue into step 2");
  assert.equal(resumed.task.state, "completed");
});

// --- Latency instrumentation (bottleneck-analysis follow-up: no real
// latency measurements existed before this). Uses an injectable clock so
// durations are asserted exactly, not within a real-time tolerance window.

test("records decision_wait and execute durations with an injectable clock", async () => {
  const clock = makeFakeClock();
  const api = makeApi(async () => {
    clock.advance(15); // simulated approver round-trip
    return { decision: "allow", reasons: [] };
  }, { now: clock.now });

  await api.performGatedAction({ requestId: "r1", action: "navigate", summary: "go" }, async () => {
    clock.advance(40); // simulated execute() cost
  });

  const metrics = api.getMetricsSummary();
  assert.equal(metrics.decision_wait.count, 1);
  assert.equal(metrics.decision_wait.p50, 15);
  assert.deepEqual(metrics.decision_wait.outcomes, { allow: 1 });
  assert.equal(metrics.execute.count, 1);
  assert.equal(metrics.execute.p50, 40);
});

test("records queue_wait from when an item is queued to when it's approved or denied", async () => {
  const clock = makeFakeClock();
  const api = makeApi(async () => ({ decision: "review", reasons: ["needs a human"] }), { now: clock.now });

  await api.performGatedAction({ requestId: "r1", action: "navigate", summary: "go" }, async () => {});
  clock.advance(500); // simulated reviewer response time
  await api.approve("r1");

  await api.performGatedAction({ requestId: "r2", action: "navigate", summary: "go" }, async () => {});
  clock.advance(120);
  await api.deny("r2");

  const metrics = api.getMetricsSummary();
  assert.equal(metrics.queue_wait.count, 2);
  assert.deepEqual(metrics.queue_wait.outcomes, { approved: 1, denied: 1 });
});

test("records task_total on a completed task and on an explicit stop, with matching outcomes", async () => {
  const clock = makeFakeClock();
  const api = makeApi(async () => ({ decision: "allow", reasons: [] }), { now: clock.now });
  api.navigate = async () => {
    clock.advance(10);
  };
  api._findFirstOutboundLink = async () => {
    clock.advance(5);
    return null;
  };

  await api.startTask("https://example.com");
  assert.deepEqual(api.getMetricsSummary().task_total.outcomes, { completed: 1 });

  api._task = { id: "t2", state: "running", pauseReason: null };
  api._taskStartedAt = clock.now();
  clock.advance(20);
  await api.stopTask();

  const metrics = api.getMetricsSummary();
  assert.equal(metrics.task_total.count, 2);
  assert.deepEqual(metrics.task_total.outcomes, { completed: 1, stopped: 1 });
});

// --- Navigation timeout/abort (a hanging loadURL() previously had no bound
// at all -- performGatedAction()'s caller would wait forever).

test("navigate() aborts and reports a timeout instead of hanging forever on a stuck loadURL()", async () => {
  const api = makeApi(async () => ({ decision: "allow", reasons: [] }), { navigationTimeoutMs: 20 });
  let stopped = false;
  api._view = makeFakeView({
    loadURL: () => new Promise(() => {}), // never resolves -- simulates a hung page load
    stop: () => {
      stopped = true;
    },
  });

  const start = Date.now();
  const snapshot = await api.navigate("https://example.com");
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 300, `expected navigate() to resolve near the 20ms timeout, took ${elapsed}ms`);
  assert.equal(stopped, true, "a hung load must be actively aborted via webContents.stop(), not just abandoned");
  assert.equal(snapshot.page.loadState, "error");

  const metrics = api.getMetricsSummary();
  assert.equal(metrics.navigation.count, 1);
  assert.deepEqual(metrics.navigation.outcomes, { timeout: 1 });
});

test("navigate() does not abort a load that finishes well within the timeout", async () => {
  const api = makeApi(async () => ({ decision: "allow", reasons: [] }), { navigationTimeoutMs: 5000 });
  let stopped = false;
  api._view = makeFakeView({
    loadURL: async () => {},
    stop: () => {
      stopped = true;
    },
  });

  await api.navigate("https://example.com");

  assert.equal(stopped, false);
  const metrics = api.getMetricsSummary();
  assert.deepEqual(metrics.navigation.outcomes, { ok: 1 });
});

// --- Bounded DOM scan for the outbound-link read (prevents a pathological
// page's anchor count from turning one page read into an unbounded walk).

test("_findFirstOutboundLink bounds the anchor scan to maxDomLinksScanned and records a dom_read metric", async () => {
  const api = makeApi(async () => ({ decision: "allow", reasons: [] }), { maxDomLinksScanned: 7 });
  let receivedScript = null;
  api._view = makeFakeView({
    executeJavaScript: async (script) => {
      receivedScript = script;
      return { href: "https://example.com/next", text: "Next" };
    },
  });

  const link = await api._findFirstOutboundLink();

  assert.deepEqual(link, { href: "https://example.com/next", text: "Next" });
  assert.match(receivedScript, /Math\.min\(anchors\.length, 7\)/);
  const metrics = api.getMetricsSummary();
  assert.equal(metrics.dom_read.count, 1);
  assert.deepEqual(metrics.dom_read.outcomes, { found: 1 });
});

test("_findFirstOutboundLink records a dom_read error outcome when the page read itself throws", async () => {
  const api = makeApi(async () => ({ decision: "allow", reasons: [] }));
  api._view = makeFakeView({
    executeJavaScript: async () => {
      throw new Error("boom");
    },
  });

  const link = await api._findFirstOutboundLink();

  assert.equal(link, null);
  assert.deepEqual(api.getMetricsSummary().dom_read.outcomes, { error: 1 });
});
