"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");
const { buildPrompt } = require("../main/harness/providers/claude-code-bridge");

async function fixture(t, action, permissionMode = "interact", { computerUse = false, capabilityId = "computer_use" } = {}) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-interaction-controller-"));
  const store = await TaskStore.create({ originalRequest: "update profile" }, { storageRoot });
  let turns = 0; const executed = []; let plannerOptions = null; let attachmentDisposed = false;
  const browser = { supportsAction: () => true,
    observe: async () => ({ id: "obs", documentEpoch: 7, url: "https://page.test/", elements: [
      { elementId: "0", role: "textbox", name: "Title" },
      { elementId: "1", role: "button", name: "Submit", formAction: "https://submit.test/save", formMethod: "post" },
    ] }),
    ...(computerUse ? { captureComputerUseObservation: async (observation) => ({
      binding: { observationId: observation.id, taskId: store.taskId, agentId: "22222222-2222-4222-8222-222222222222", documentEpoch: observation.documentEpoch, origin: "https://page.test", capturedAt: 1, viewport: { width: 1440, height: 900 }, digest: "a".repeat(64) },
      attachment: { id: "attachment-1", path: "/private/fake.png", dispose: async () => { attachmentDisposed = true; } },
    }) } : {}),
    execute: async (a, options) => { executed.push({ action: a, options }); return { status: "ok" }; },
  };
  const controller = new TaskController({ store, browser, permissionMode,
    approve: async () => ({ decision: "allow", reasons: [] }), hostVerifier: () => true,
    planner: { next: async (c, options) => {
      plannerOptions = options;
      if (computerUse) {
        assert.equal(c.observation.computerUse.taskId, store.taskId);
        assert.equal(JSON.stringify(c).includes("/private/fake.png"), false, "attachment paths stay out of context");
      }
      const base = { taskId: c.taskId, goalVersion: c.goalVersion, basedOnObservationId: c.observation.id, criterionIds: [] };
      return turns++ === 0 ? { ...base, kind: "actions", actions: [action] } : { ...base, kind: "finish", evidenceIds: [] };
    } },
  });
  if (computerUse) store.taskProfile = { capability: { id: capabilityId, adapters: capabilityId === "multi_agent" ? [
      { capabilityId: "browser", adapterId: "planner-browser", adapterVersion: 1 },
      { capabilityId: "computer_use", adapterId: "codex-subscription-image", adapterVersion: 1 },
      { capabilityId: "multi_agent", adapterId: "child-agent-coordinator", adapterVersion: 1 },
    ] : [
      { capabilityId: "browser", adapterId: "task-owned-viewport-screenshot", adapterVersion: 1 },
      { capabilityId: "computer_use", adapterId: "codex-subscription-image", adapterVersion: 1 },
    ] } };
  t.after(async () => { await controller.stop(); await store.close(); await fs.rm(storageRoot, { recursive: true, force: true }); });
  await controller.start(); return { controller, executed, store, get plannerOptions() { return plannerOptions; }, get attachmentDisposed() { return attachmentDisposed; } };
}

test("typing review shows target and exact input, and approval keeps the observation epoch", async t => {
  const action = { type: "type", elementId: "0", text: "New title" };
  const { controller, executed } = await fixture(t, action);
  const [item] = controller.getSnapshot().approvalQueue;
  assert.equal(controller.getSnapshot().state, "awaiting_approval");
  assert.match(item.target, /Title/);
  assert.match(item.target, /New title/);
  assert.equal(executed.length, 0);
  await controller.approve(item.id);
  assert.equal(executed.length, 1);
  assert.deepEqual(executed[0].action, action);
  assert.equal(executed[0].options.documentEpoch, 7);
});

test("a form review displays destination and method, and denial dispatches nothing", async t => {
  const { controller, executed } = await fixture(t, { type: "submit_form", elementId: "1" });
  const [item] = controller.getSnapshot().approvalQueue;
  assert.match(item.target, /https:\/\/submit.test\/save/);
  assert.match(item.target, /POST/);
  await controller.deny(item.id);
  assert.equal(executed.length, 0);
});

test("both CLI planners receive interaction shapes and fresh-observation instructions", () => {
  const prompt = buildPrompt({ observation: { elements: [] }, progress: {}, goal: {} });
  for (const type of ["click", "type", "submit_form"]) assert.ok(prompt.includes(`"type": "${type}"`));
  assert.match(prompt, /one interaction/);
  assert.match(prompt, /password/);
});

test("computer-use proposals keep the image out-of-band and wait in the ordinary approval queue", async t => {
  const action = { type: "click_at", observationId: "obs", x: 0.25, y: 0.75 };
  const { controller, executed, plannerOptions, attachmentDisposed } = await fixture(t, action, "interact", { computerUse: true });
  const [item] = controller.getSnapshot().approvalQueue;
  assert.equal(controller.getSnapshot().state, "awaiting_approval");
  assert.match(item.target, /screenshot obs/);
  assert.match(item.target, /25%, 75%/);
  assert.equal(executed.length, 0);
  assert.deepEqual(plannerOptions.attachments, [{ kind: "image", id: "attachment-1", path: "/private/fake.png" }]);
  assert.equal(attachmentDisposed, true, "the temporary image is removed as soon as planning settles");
  await controller.approve(item.id);
  assert.equal(executed.length, 1);
  assert.deepEqual(executed[0].action, action);
  assert.equal(executed[0].options.documentEpoch, 7);
});

test("computer-use team conversation can use screenshot actions through the parent approval queue", async t => {
  const action = { type: "click_at", observationId: "obs", x: 0.25, y: 0.75 };
  const { controller, executed, plannerOptions, attachmentDisposed } = await fixture(t, action, "interact", { computerUse: true, capabilityId: "multi_agent_computer_use" });
  // Composite team tasks run CUA in the parent controller; children remain observe-only.
  const [item] = controller.getSnapshot().approvalQueue;
  assert.equal(controller.getSnapshot().state, "awaiting_approval");
  assert.match(item.target, /screenshot obs/);
  assert.equal(executed.length, 0);
  assert.equal(plannerOptions.attachments.length, 1);
  assert.equal(attachmentDisposed, true);
  await controller.approve(item.id);
  assert.equal(executed.length, 1);
});

test("a coordinate proposal naming a different screenshot observation never reaches approval or browser dispatch", async t => {
  const action = { type: "click_at", observationId: "stale-observation", x: 0.25, y: 0.75 };
  const { controller, executed } = await fixture(t, action, "interact", { computerUse: true });
  assert.notEqual(controller.getSnapshot().state, "awaiting_approval");
  assert.equal(controller.getSnapshot().approvalQueue.length, 0);
  assert.equal(executed.length, 0);
});

test("a lost coordinate-input result pauses as execution_uncertain and is never automatically retried", async t => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-cu-uncertain-"));
  const store = await TaskStore.create({ originalRequest: "Click once" }, { storageRoot });
  store.taskProfile = { capability: { id: "computer_use", adapters: [
    { capabilityId: "browser", adapterId: "task-owned-viewport-screenshot", adapterVersion: 1 },
    { capabilityId: "computer_use", adapterId: "codex-subscription-image", adapterVersion: 1 },
  ] } };
  let plannerCalls = 0;
  let executeCalls = 0;
  const controller = new TaskController({
    store,
    permissionMode: "interact",
    approve: async () => ({ decision: "allow", reasons: [] }),
    hostVerifier: () => true,
    browser: {
      observe: async () => ({ id: "obs-uncertain", documentEpoch: 1, url: "https://page.test/" }),
      captureComputerUseObservation: async () => ({
        binding: { observationId: "obs-uncertain", taskId: store.taskId, agentId: null, documentEpoch: 1, origin: "https://page.test", capturedAt: 1, viewport: { width: 1440, height: 900 }, digest: "a".repeat(64) },
        attachment: { id: "private-shot", path: "/private/shot.png", dispose: async () => {} },
      }),
      execute: async () => { executeCalls += 1; throw Object.assign(new Error("input delivery lost"), { code: "execution_uncertain" }); },
    },
    planner: { next: async (context) => {
      plannerCalls += 1;
      return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: context.observation.id, criterionIds: [], kind: "actions", actions: [
        { type: "click_at", observationId: context.observation.id, x: 0.4, y: 0.4 },
      ] };
    } },
  });
  t.after(async () => { await controller.stop(); await store.close(); await fs.rm(storageRoot, { recursive: true, force: true }); });
  await controller.start();
  const [approval] = controller.getSnapshot().approvalQueue;
  assert.ok(approval);
  await controller.approve(approval.id);
  const snapshot = controller.getSnapshot();
  assert.equal(snapshot.state, "paused");
  assert.equal(snapshot.pauseReason, "execution_uncertain");
  assert.equal(executeCalls, 1);
  assert.equal(plannerCalls, 1);
  await assert.rejects(controller.resume(), { code: "confirmation_required" });
  assert.equal(executeCalls, 1);
  assert.equal(plannerCalls, 1);
});
