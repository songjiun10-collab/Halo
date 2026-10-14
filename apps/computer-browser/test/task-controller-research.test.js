"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");

const A = "https://news.example/a-report";
const B = "https://other.test/analysis";
const C = "https://made-up.invalid/claim";
const TITLES = { [A]: "A report", [B]: "An analysis" };

// script: planner steps, each a function (observationId, context) => proposal fields.
async function run(t, { request = "Research how heat pumps compare, cite sources", research = true, script, before }) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-research-"));
  const store = await TaskStore.create({ originalRequest: request }, { storageRoot });
  if (research) store.taskProfile = { capability: { id: "research", adapters: [{ capabilityId: "browser", adapterId: "planner-browser", adapterVersion: 1 }, { capabilityId: "research", adapterId: "source-grounded-playbook", adapterVersion: 1 }] } };
  if (before) await before(store);
  const page = { url: "about:blank" };
  let obs = 0;
  const seen = [];
  const browser = {
    supportsAction: () => true,
    observe: async () => ({ id: `obs${++obs}`, documentEpoch: 1, url: page.url, title: TITLES[page.url] ?? "", text: "page text", elements: [] }),
    execute: async (action) => { if (action.type === "navigate") page.url = action.url; return { status: "ok" }; },
  };
  let call = 0;
  const controller = new TaskController({
    store, browser, permissionMode: "interact", approve: async () => ({ decision: "allow", reasons: [] }), hostVerifier: () => true,
    planner: { next: async (c) => {
      seen.push(c.progress?.research ?? null);
      const step = script[Math.min(call++, script.length - 1)];
      return { taskId: c.taskId, goalVersion: c.goalVersion, basedOnObservationId: c.observation.id, criterionIds: [], ...step() };
    } },
  });
  t.after(async () => { await controller.stop(); await store.close(); await fs.rm(storageRoot, { recursive: true, force: true }); });
  await controller.start();
  const events = await store.getEvents();
  const notes = events.filter((e) => e.type === "note").map((e) => e.payload);
  return { controller, seen, notes, get planned() { return call; } };
}
const go = (url) => () => ({ kind: "actions", actions: [{ type: "navigate", url }] });
const say = (reason) => () => ({ kind: "need_user", reason });
const kinds = (r) => r.notes.map((n) => n.kind);

test("an answer citing only pages the host opened, on two independent sites, is delivered with the host's own source list", async (t) => {
  const r = await run(t, { script: [go(A), go(B), say(`Heat pumps cut running costs (${A}). Installation costs differ (${B}).`)] });
  const snap = r.controller.getSnapshot();
  assert.equal(snap.pauseReason, "need_user");
  assert.match(snap.needUserReason, /Heat pumps cut running costs/);
  assert.match(snap.needUserReason, /Sources Halo opened \(host-verified\):\n1\. A report - https:\/\/news\.example\/a-report/);
  assert.match(snap.needUserReason, /2\. An analysis - https:\/\/other\.test\/analysis/);
  assert.deepEqual(kinds(r).filter((k) => k.startsWith("research_")), ["research_source", "research_source", "research_answer_checked"]);
});

test("an answer that cites a page nobody opened is sent back, the planner is told why, and the corrected answer goes through", async (t) => {
  const r = await run(t, { script: [go(A), go(B), say(`Claim (${A}), claim (${B}), claim (${C}).`), say(`Claim (${A}) and claim (${B}).`)] });
  const snap = r.controller.getSnapshot();
  assert.equal(snap.pauseReason, "need_user");
  assert.doesNotMatch(snap.needUserReason, /made-up/);
  assert.match(snap.needUserReason, /Sources Halo opened/);
  assert.ok(kinds(r).includes("research_answer_rejected"));
  const told = r.seen.find((s) => s && s.rejectedAnswers === 1);
  assert.ok(told, "the planner saw the rejection");
  assert.deepEqual(told.lastRejection.reasons, ["unverified_source"]);
  assert.deepEqual(told.lastRejection.unopenedUrls, [C]);
  assert.deepEqual(told.openedSources.map((s) => s.url), [A, B], "it is also told which pages it may cite");
  assert.equal(JSON.stringify(r.notes).includes("made-up"), false, "the journal keeps counts, not the rejected text");
});

test("one site is one source: after two rejections the answer still reaches the person, marked as unverified", async (t) => {
  const r = await run(t, { script: [go(A), say(`Claim (${A}).`)] });
  const snap = r.controller.getSnapshot();
  assert.equal(snap.pauseReason, "need_user");
  assert.equal(r.planned, 4, "navigate + three answers");
  assert.equal(kinds(r).filter((k) => k === "research_answer_rejected").length, 2);
  assert.ok(kinds(r).includes("research_answer_unverified_delivered"));
  assert.match(snap.needUserReason, /\[Not verified by Halo: fewer than 2 independent sites were verified/);
});

test("a question to the person, or any task that is not research, is left alone", async (t) => {
  const question = await run(t, { script: [say("Which heat pump type should I focus on?")] });
  assert.equal(question.controller.getSnapshot().needUserReason, "Which heat pump type should I focus on?");
  assert.equal(kinds(question).some((k) => k.startsWith("research_")), false);
  const plain = await run(t, { research: false, request: "look something up", script: [go(A), say(`It is true (${C}).`)] });
  assert.match(plain.controller.getSnapshot().needUserReason, /made-up/);
  assert.equal(kinds(plain).some((k) => k.startsWith("research_")), false);
  assert.equal(plain.seen.every((s) => s === null), true, "no research state for other tasks");
});

test("error pages and non-web pages never become sources", async (t) => {
  const r = await run(t, { script: [go("https://broken.example/missing"), say("ok")], before: async () => {} });
  assert.equal(kinds(r).includes("research_source"), true, "a normal page is recorded");
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-research-err-"));
  const store = await TaskStore.create({ originalRequest: "research errors" }, { storageRoot });
  store.taskProfile = { capability: { id: "research", adapters: [] } };
  const browser = { supportsAction: () => true, observe: async () => ({ id: "o1", documentEpoch: 1, url: "https://down.example/x", httpStatus: 404, text: "not found", elements: [] }), execute: async () => ({ status: "ok" }) };
  const controller = new TaskController({ store, browser, permissionMode: "interact", approve: async () => ({ decision: "allow", reasons: [] }), hostVerifier: () => true,
    planner: { next: async (c) => ({ taskId: c.taskId, goalVersion: c.goalVersion, basedOnObservationId: c.observation.id, criterionIds: [], kind: "need_user", reason: "nothing found" }) } });
  t.after(async () => { await controller.stop(); await store.close(); await fs.rm(storageRoot, { recursive: true, force: true }); });
  await controller.start();
  const notes = (await store.getEvents()).filter((e) => e.type === "note").map((e) => e.payload.kind);
  assert.equal(notes.includes("research_source"), false);
});

test("sources and the rejection count come back from the journal, so a restart cannot reset the loop", async (t) => {
  const r = await run(t, {
    script: [say(`New claim (${C}).`)],
    before: async (store) => {
      await store.append({ type: "note", payload: { kind: "research_source", url: A, title: "A report", at: 1 } });
      await store.append({ type: "note", payload: { kind: "research_source", url: B, title: "An analysis", at: 2 } });
      await store.append({ type: "note", payload: { kind: "research_answer_rejected", reasons: ["unverified_source"], unopened: 1, sites: 2 } });
      await store.append({ type: "note", payload: { kind: "research_answer_rejected", reasons: ["unverified_source"], unopened: 1, sites: 2 } });
    },
  });
  assert.equal(r.planned, 1, "no further retry after a restart: the earlier rejections count");
  assert.match(r.controller.getSnapshot().needUserReason, /\[Not verified by Halo: it cites 1 page Halo never opened/);
  assert.deepEqual(r.seen[0].openedSources.map((s) => s.url), [A, B], "the first turn already knows the restored sources");
});

test("sources and rejections recorded after the first 200 journal events are restored too", async (t) => {
  const r = await run(t, {
    script: [say(`New claim (${C}).`)],
    before: async (store) => {
      for (let i = 0; i < 260; i += 1) await store.append({ type: "note", payload: { kind: "filler", i } });
      await store.append({ type: "note", payload: { kind: "research_source", url: A, title: "A report", at: 1 } });
      await store.append({ type: "note", payload: { kind: "research_source", url: B, title: "An analysis", at: 2 } });
      await store.append({ type: "note", payload: { kind: "research_answer_rejected", reasons: ["unverified_source"], unopened: 1, sites: 2 } });
      await store.append({ type: "note", payload: { kind: "research_answer_rejected", reasons: ["unverified_source"], unopened: 1, sites: 2 } });
    },
  });
  assert.equal(r.planned, 1, "the late rejections still count");
  assert.deepEqual(r.seen[0].openedSources.map((s) => s.url), [A, B], "the late sources are known on the first turn");
});
