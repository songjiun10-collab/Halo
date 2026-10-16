"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { TaskBranchManager, BRANCH_POLICY_MODE } = require("../main/harness/task-branch-manager");
const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");
const contracts = require("../shared/harness-contracts");

const tick = () => new Promise((r) => setTimeout(r, 5));

test("manager: only https steps on other origins start, capped per approval and per task", async () => {
  const seen = [];
  const mgr = new TaskBranchManager({ runner: async (job) => { seen.push(job); await new Promise(() => {}); } });
  assert.equal(mgr.offer({ approvalId: "a", steps: [{ url: "http://x.test/", purpose: "p" }, { url: "javascript:1", purpose: "p" }] }), null);
  assert.equal(mgr.offer({ approvalId: "a", steps: [{ url: "https://pending.test/x", purpose: "p" }], pendingOrigin: "https://pending.test" }), null, "never the pending page's origin");
  const first = mgr.offer({ approvalId: "a", steps: [{ url: "https://other.test/", purpose: "read\u0000 it" }] });
  assert.ok(first);
  assert.equal(mgr.offer({ approvalId: "a", steps: [{ url: "https://other.test/2", purpose: "again" }] }), null, "one per approval");
  assert.ok(mgr.offer({ approvalId: "b", steps: [{ url: "https://other.test/", purpose: "p" }] }));
  assert.equal(mgr.offer({ approvalId: "c", steps: [{ url: "https://other.test/", purpose: "p" }] }), null, "two per task");
  await tick();
  assert.equal(seen[0].policyMode, BRANCH_POLICY_MODE);
  assert.equal(seen[0].policyMode, "browse");
  assert.equal(seen[0].steps[0].purpose, "read it");
  mgr.closeAll();
});

test("manager: approval merges findings once as bounded text; rejection discards; runner is aborted", async () => {
  let signal;
  const mgr = new TaskBranchManager({ runner: async (job) => {
    signal = job.signal;
    job.report({ url: "https://other.test/a", text: `price\u0007 ${"x".repeat(5000)}` });
    await new Promise(() => {});
  } });
  mgr.offer({ approvalId: "ok", steps: [{ url: "https://other.test/", purpose: "p" }] });
  await tick();
  mgr.resolve("ok", "approved");
  assert.equal(signal.aborted, true);
  const merged = mgr.takeMerged();
  assert.equal(merged.length, 1);
  assert.ok(merged[0].text.length < 800);
  assert.equal(/[\u0000-\u001f]/.test(merged[0].text), false);
  assert.equal(merged[0].origin, "https://other.test");
  assert.deepEqual(mgr.takeMerged(), []);

  mgr.offer({ approvalId: "no", steps: [{ url: "https://other.test/", purpose: "p" }] });
  await tick();
  mgr.resolve("no", "rejected");
  assert.deepEqual(mgr.takeMerged(), []);
  assert.deepEqual(mgr.list().map((b) => b.state), ["merged", "discarded"]);
  mgr.closeAll();
});

test("manager: wall-clock and finding budgets abort the runner; a throwing runner just fails", async () => {
  let signal;
  const slow = new TaskBranchManager({ maxMs: 20, runner: async (job) => { signal = job.signal; await new Promise(() => {}); } });
  slow.offer({ approvalId: "t", steps: [{ url: "https://o.test/", purpose: "p" }] });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(signal.aborted, true);
  assert.equal(slow.list()[0].state, "aborted");
  const bad = new TaskBranchManager({ runner: async () => { throw new Error("boom"); } });
  bad.offer({ approvalId: "x", steps: [{ url: "https://o.test/", purpose: "p" }] });
  await tick();
  assert.equal(bad.list()[0].state, "failed");
});

test("contract: waitingWork is accepted only on actions proposals and is bounded", () => {
  const base = { taskId: "11111111-1111-4111-8111-111111111111", goalVersion: 1, basedOnObservationId: "o", criterionIds: [] };
  const ok = { ...base, kind: "actions", actions: [{ type: "scroll" }], waitingWork: [{ url: "https://a.test/", purpose: "read" }] };
  assert.doesNotThrow(() => contracts.validateProposalEnvelope(ok));
  assert.throws(() => contracts.validateProposalEnvelope({ ...ok, waitingWork: new Array(4).fill({ url: "https://a.test/", purpose: "p" }) }));
  assert.throws(() => contracts.validateProposalEnvelope({ ...ok, waitingWork: [{ url: "https://a.test/", purpose: "p", extra: 1 }] }));
  assert.throws(() => contracts.validateProposalEnvelope({ ...base, kind: "finish", evidenceIds: [], waitingWork: [] }));
});

async function controllerFixture(t) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-branch-"));
  const store = await TaskStore.create({ originalRequest: "delete the draft and compare prices" }, { storageRoot });
  const memories = []; let turns = 0; const jobs = []; let aborted = false;
  const browser = { supportsAction: () => true,
    observe: async () => ({ id: "obs", documentEpoch: 3, url: "https://shop.test/", elements: [{ elementId: "0", role: "button", name: "Delete" }] }),
    execute: async () => ({ status: "ok" }) };
  const controller = new TaskController({ store, browser, permissionMode: "interact", hostVerifier: () => true,
    approve: async () => ({ decision: "allow", reasons: [] }),
    branchRunner: async (job) => { jobs.push(job); job.signal.addEventListener("abort", () => { aborted = true; }); job.report({ url: "https://rival.test/p", text: "Rival price is 10" }); await new Promise(() => {}); },
    planner: { next: async (c) => {
      memories.push(c.userMemory?.entries ?? []);
      const base = { taskId: c.taskId, goalVersion: c.goalVersion, basedOnObservationId: c.observation.id, criterionIds: [] };
      return turns++ === 0
        ? { ...base, kind: "actions", actions: [{ type: "click", elementId: "0" }], waitingWork: [{ url: "https://rival.test/p", purpose: "compare prices" }] }
        : { ...base, kind: "finish", evidenceIds: [] };
    } } });
  t.after(async () => { await controller.stop(); await store.close(); await fs.rm(storageRoot, { recursive: true, force: true }); });
  await controller.start();
  return { controller, memories, jobs, get aborted() { return aborted; } };
}

test("controller: a pending approval starts a read-only branch; approving merges it as untrusted memory", async (t) => {
  const f = await controllerFixture(t);
  await tick();
  const snap = f.controller.getSnapshot();
  assert.equal(snap.state, "awaiting_approval");
  assert.equal(snap.branches.length, 1);
  assert.equal(f.jobs[0].policyMode, "browse");
  assert.equal(JSON.stringify(snap).includes("Rival price"), false, "findings stay host-side");
  await f.controller.approve(snap.approvalQueue[0].id);
  assert.equal(f.aborted, true);
  const last = f.memories.at(-1);
  assert.ok(last.some((e) => /Rival price is 10/.test(e.text)), "merged into the next planner turn");
});

test("controller: rejecting the approval discards the branch's findings", async (t) => {
  const f = await controllerFixture(t);
  await tick();
  const [item] = f.controller.getSnapshot().approvalQueue;
  await f.controller.deny(item.id);
  assert.equal(f.aborted, true);
  assert.equal(f.controller.getSnapshot().branches[0].state, "discarded");
  assert.equal(f.memories.flat().some((e) => /Rival price/.test(e.text)), false);
});

test("branch runner reads each page in a fresh observe-only surface, always disposes, stops on abort", async () => {
  const { createBranchRunner } = require("../main/harness/branch-runner");
  const made = []; const disposed = []; const reports = [];
  const runner = createBranchRunner({ makeBrowser: (id, origin) => {
    made.push({ id, origin });
    return { userNavigate: async () => {}, observe: async () => ({ url: `${origin}/x`, title: "T", text: "body ".repeat(400) }), dispose: async () => { disposed.push(id); } };
  } });
  const ctl = new AbortController();
  await runner({ branchId: "b", steps: [{ url: "https://a.test/1", purpose: "price" }, { url: "https://b.test/2", purpose: "stock" }], signal: ctl.signal, report: (r) => reports.push(r) });
  assert.deepEqual(made.map((m) => m.origin), ["https://a.test", "https://b.test"]);
  assert.deepEqual(disposed, ["b-0", "b-1"]);
  assert.equal(reports.length, 2);
  assert.ok(reports[0].text.startsWith("price — T:") && reports[0].text.length < 600);
  ctl.abort(); made.length = 0;
  await runner({ branchId: "c", steps: [{ url: "https://a.test/1", purpose: "p" }], signal: ctl.signal, report: () => assert.fail("no report after abort") });
  assert.equal(made.length, 0);
});

test("computer use starts from a blank page: capture is skipped until the first navigation", async (t) => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-cu-blank-"));
  const store = await TaskStore.create({ originalRequest: "open wikipedia" }, { storageRoot });
  store.taskProfile = { capability: { id: "computer_use", adapters: [{ capabilityId: "computer_use", adapterId: "x", adapterVersion: 1 }] } };
  let captured = 0; let turns = 0; let sawComputerUse = null;
  const browser = { supportsAction: () => true,
    observe: async () => ({ id: "o", documentEpoch: 1, url: "about:blank", elements: [] }),
    captureTextObservation: async () => { captured += 1; throw new Error("no boxes on a blank page"); },
    execute: async () => ({ status: "ok" }) };
  const controller = new TaskController({ store, browser, permissionMode: "browse", hostVerifier: () => true,
    approve: async () => ({ decision: "allow", reasons: [] }),
    planner: { next: async (c) => { sawComputerUse = c.observation.computerUse ?? null;
      const base = { taskId: c.taskId, goalVersion: c.goalVersion, basedOnObservationId: c.observation.id, criterionIds: [] };
      return turns++ === 0 ? { ...base, kind: "actions", actions: [{ type: "navigate", url: "https://en.wikipedia.org/" }] } : { ...base, kind: "need_user", reason: "stop here" }; } } });
  t.after(async () => { await controller.stop(); await store.close(); await fs.rm(storageRoot, { recursive: true, force: true }); });
  await controller.start(); await tick();
  assert.equal(captured, 0);
  assert.equal(sawComputerUse, null);
  assert.notEqual(controller.getSnapshot().pauseReason, "computer_use_capture_failed");
});
