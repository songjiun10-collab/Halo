"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { TaskStore } = require("../main/harness/task-store");
const { TaskController } = require("../main/harness/task-controller");

const CARD = "4111111111111111";

async function run(t, { request = "결제 페이지 열어줘", actions }) {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "halo-card-blind-"));
  const store = await TaskStore.create({ originalRequest: request }, { storageRoot });
  const executed = [];
  const seen = [];
  let planned = 0;
  const browser = {
    supportsAction: () => true,
    observe: async () => ({ id: "obs", documentEpoch: 1, url: "https://shop.example/pay", text: `Saved card ${CARD.replace(/(.{4})/g, "$1 ").trim()}`, elements: [
      { elementId: "1", role: "textbox", name: "Card number", inputType: "text", value: CARD },
      { elementId: "2", role: "textbox", name: "Search", inputType: "text" },
    ] }),
    execute: async (action) => { executed.push(action); return { status: "ok" }; },
  };
  const controller = new TaskController({
    store, browser, permissionMode: "interact", approve: async () => ({ decision: "allow", reasons: [] }), hostVerifier: () => true,
    planner: { next: async (c) => {
      seen.push(JSON.stringify(c.observation));
      const base = { taskId: c.taskId, goalVersion: c.goalVersion, basedOnObservationId: c.observation.id, criterionIds: [] };
      planned += 1;
      return planned === 1 && actions ? { ...base, kind: "actions", actions } : { ...base, kind: "finish", evidenceIds: [] };
    } },
  });
  t.after(async () => { await controller.stop(); await store.close(); await fs.rm(storageRoot, { recursive: true, force: true }); });
  await controller.start();
  const events = JSON.stringify(await store.getEvents());
  return { controller, executed, seen, events, get planned() { return planned; } };
}

test("the planner and the journal never see a card number or a card field's value", async (t) => {
  const r = await run(t, {});
  assert.ok(r.seen.length >= 1);
  for (const s of r.seen) { assert.equal(s.includes(CARD), false); assert.equal(s.includes("4111 1111 1111 1111"), false); assert.match(s, /••••1111/); }
  assert.equal(r.events.includes(CARD), false);
});

test("typing into a card field is refused and handed to the person", async (t) => {
  const r = await run(t, { actions: [{ type: "type", elementId: "1", text: "123" }] });
  assert.equal(r.executed.length, 0);
  assert.equal(r.controller.getSnapshot().pauseReason, "need_user");
  assert.match(r.controller.getSnapshot().needUserReason, /직접 입력/);
});

test("typing a card number anywhere is refused, ordinary typing still works", async (t) => {
  const bad = await run(t, { actions: [{ type: "type", elementId: "2", text: CARD }] });
  assert.equal(bad.executed.length, 0);
  assert.equal(bad.controller.getSnapshot().pauseReason, "need_user");
  assert.equal(bad.events.includes(CARD), false, "the number is not journaled by the block");
  const ok = await run(t, { actions: [{ type: "type", elementId: "2", text: "shoes" }] });
  assert.equal(ok.executed.length, 1);
});

test("a card number in the chat pauses the task before anything runs", async (t) => {
  const r = await run(t, { request: `내 카드 ${CARD} 로 결제해줘` });
  assert.equal(r.planned, 0);
  assert.equal(r.controller.getSnapshot().pauseReason, "need_user");
  assert.match(r.controller.getSnapshot().needUserReason, /카드 번호/);
});
