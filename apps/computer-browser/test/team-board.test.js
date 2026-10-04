"use strict";

// Team board: while a child plan runs, what a child reports to its parent
// (progress, evidence, handoff) is also posted by the host to the plan's
// board, and every sibling reads the board as untrusted notes. No new route
// exists: children still only message their parent, and the board is
// written by the host from already-validated messages.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const { TaskStore } = require("../main/harness/task-store");
const { ChildAgentCoordinator } = require("../main/harness/child-agent-coordinator");
const { TeamBoardStore, MAX_BOARD_BYTES } = require("../main/harness/team-board-store");
const { buildContext } = require("../main/harness/context-builder");
const { resolveTaskProfile } = require("../shared/task-profile-router");
const contracts = require("../shared/harness-contracts");

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "halo-board-"));

async function plan(storageRoot, coordinator = new ChildAgentCoordinator({ storageRoot })) {
  const goalInput = { originalRequest: "parent goal" };
  const parent = await TaskStore.create(goalInput, { storageRoot, resolvedProfile: resolveTaskProfile({ goalInput, requestedCapabilityProfile: "multi_agent" }) });
  coordinator.registerStore(parent.taskId, parent);
  const { childIds } = await coordinator.acceptParentPlan(parent.taskId, {
    taskId: parent.taskId, goalVersion: 1, basedOnObservationId: "obs-1", criterionIds: [], kind: "child_plan",
    parentGoalVersion: 1, requestedAgentCount: 3,
    assignments: [
      { subgoal: "Flights", entryUrl: "https://a.example/start" },
      { subgoal: "Hotels", entryUrl: "https://b.example/start" },
      { subgoal: "Cars", entryUrl: "https://c.example/start" },
    ],
  }, { parentStore: parent, memoryPolicy: "user_override" });
  const stores = [];
  for (const childId of childIds) {
    const store = await TaskStore.loadChild(childId, { storageRoot, parentTaskId: parent.taskId });
    coordinator.registerStore(childId, store);
    stores.push(store);
  }
  const close = () => Promise.all([parent, ...stores].map((s) => s.close()));
  return { coordinator, parent, childIds, close };
}

let n = 0;
const send = (coordinator, from, to, fields) => coordinator.handleSendMessage(from, {
  kind: "send_message", recipientTaskId: to, idempotencyKey: `k-${n += 1}`, ...fields,
});

test("a child's report to its parent is posted to the board and read by its siblings only", async () => {
  const storageRoot = await tmp();
  const { coordinator, parent, childIds, close } = await plan(storageRoot);
  try {
    await send(coordinator, childIds[0], parent.taskId, { messageKind: "progress", text: "Cheapest flight is KE123 on Fri." });
    await send(coordinator, childIds[0], parent.taskId, { messageKind: "question", text: "Which dates?" });
    await send(coordinator, parent.taskId, childIds[1], { messageKind: "steer", text: "focus on Jeju" });
    await send(coordinator, childIds[2], parent.taskId, { messageKind: "handoff", handoff: {
      objective: "Rent a car", currentState: "Two options found", verifiedResults: [], unresolved: ["insurance"], risks: [], suggestedNextAction: "compare",
    } });

    const forSecond = await coordinator.readTeamBoard(childIds[1]);
    assert.equal(forSecond.authority, "untrusted_sibling_notes");
    assert.equal(forSecond.parentTaskId, parent.taskId);
    assert.deepEqual(forSecond.entries.map((e) => [e.from, e.kind]), [["Flights", "progress"], ["Cars", "handoff"]]);
    assert.equal(forSecond.entries[0].text, "Cheapest flight is KE123 on Fri.");
    assert.match(forSecond.entries[1].text, /Rent a car/);
    assert.match(forSecond.entries[1].text, /Two options found/);
    assert.match(forSecond.entries[1].text, /insurance/);

    const forFirst = await coordinator.readTeamBoard(childIds[0]);
    assert.deepEqual(forFirst.entries.map((e) => e.from), ["Cars"], "a child does not read its own posts back");

    assert.equal(await coordinator.readTeamBoard(parent.taskId), null, "only children read the board");

    const summary = await coordinator.getPlanSummary(parent.taskId);
    assert.deepEqual(summary.board.map((e) => [e.agentId, e.kind]), [[childIds[0], "progress"], [childIds[2], "handoff"]]);
  } finally {
    await close();
  }
});

test("a resent message is posted once and the board survives a restart", async () => {
  const storageRoot = await tmp();
  const { coordinator, parent, childIds, close } = await plan(storageRoot);
  try {
    const message = { kind: "send_message", recipientTaskId: parent.taskId, messageKind: "evidence", idempotencyKey: "same", text: "Price page saved." };
    await coordinator.handleSendMessage(childIds[0], message);
    await coordinator.handleSendMessage(childIds[0], message);
    assert.equal((await coordinator.getPlanSummary(parent.taskId)).board.length, 1);

    await close();
    const restarted = new ChildAgentCoordinator({ storageRoot });
    assert.deepEqual((await restarted.getPlanSummary(parent.taskId)).board.map((e) => e.text), ["Price page saved."]);
  } finally {
    await close().catch(() => {});
  }
});

test("posts from another goal version, a cancelled plan or a non-member are never shown", async () => {
  const storageRoot = await tmp();
  const { coordinator, parent, childIds, close } = await plan(storageRoot);
  try {
    const board = new TeamBoardStore({ storageRoot });
    const at = new Date().toISOString();
    await board.post(parent.taskId, { entryId: "old", parentGoalVersion: 2, childTaskId: childIds[0], kind: "progress", text: "stale", at });
    await board.post(parent.taskId, { entryId: "alien", parentGoalVersion: 1, childTaskId: "99999999-9999-4999-8999-999999999999", kind: "progress", text: "alien", at });
    assert.deepEqual((await coordinator.readTeamBoard(childIds[1])).entries, []);
    assert.equal(Object.hasOwn(await coordinator.getPlanSummary(parent.taskId), "board"), false, "an empty board is left out of the summary");
    await send(coordinator, childIds[0], parent.taskId, { messageKind: "progress", text: "visible" });
    await coordinator.cancelPlan(parent.taskId, "user_stop", { parentStore: parent });
    assert.equal(await coordinator.readTeamBoard(childIds[1]), null);
  } finally {
    await close();
  }
});

test("the board file is private, refuses symlinks and stops growing at its size cap", async () => {
  const storageRoot = await tmp();
  const board = new TeamBoardStore({ storageRoot });
  const parentId = "11111111-1111-4111-8111-111111111111";
  const child = "22222222-2222-4222-8222-222222222222";
  const at = new Date().toISOString();
  await board.post(parentId, { entryId: "e1", parentGoalVersion: 1, childTaskId: child, kind: "progress", text: "x", at });
  const file = path.join(storageRoot, "boards", `${parentId}.jsonl`);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
  await assert.rejects(board.post(parentId, { entryId: "e2", parentGoalVersion: 1, childTaskId: child, kind: "nope", text: "x", at }), { code: "invalid_entry" });

  // Fill the file close to the cap with valid lines, then one more post is refused.
  const line = (i) => `${JSON.stringify({ entryId: `f${i}`, parentGoalVersion: 1, childTaskId: child, kind: "progress", text: "y".repeat(900), at })}\n`;
  let filler = "";
  for (let i = 0; Buffer.byteLength(filler) + 2000 < MAX_BOARD_BYTES; i += 1) filler += line(i);
  await fs.appendFile(file, filler);
  const refused = await board.post(parentId, { entryId: "last", parentGoalVersion: 1, childTaskId: child, kind: "progress", text: "y".repeat(1000), at }).then(() => null, (error) => error);
  assert.equal(refused?.code, "board_full");

  const other = "33333333-3333-4333-8333-333333333333";
  await fs.symlink(path.join(storageRoot, "elsewhere"), path.join(storageRoot, "boards", `${other}.jsonl`));
  await assert.rejects(board.post(other, { entryId: "s", parentGoalVersion: 1, childTaskId: child, kind: "progress", text: "x", at }), { code: "unsafe_path" });
  await assert.rejects(board.read(other), { code: "unsafe_path" });
});

test("the context carries the board as untrusted notes within its own byte budget", () => {
  const goal = contracts.normalizeGoalSpec({ originalRequest: "child goal" }, { taskId: "44444444-4444-4444-8444-444444444444", goalVersion: 1, createdAt: new Date().toISOString() });
  const base = { goal, state: {}, observation: null, recentEvents: [] };
  assert.equal(Object.hasOwn(buildContext(base), "teamBoard"), false);
  const entries = Array.from({ length: 40 }, (_, i) => ({ from: "Flights", kind: "progress", text: `${i}:${"z".repeat(900)}`, at: "2026-10-02T00:00:00.000Z" }));
  const context = buildContext({ ...base, teamBoard: { authority: "untrusted_sibling_notes", parentTaskId: "11111111-1111-4111-8111-111111111111", entries } });
  assert.equal(context.teamBoard.authority, "untrusted_sibling_notes");
  assert.ok(context.teamBoard.entries.length > 0 && context.teamBoard.entries.length < 40);
  assert.ok(Buffer.byteLength(JSON.stringify(context.teamBoard.entries)) <= 8 * 1024);
  assert.equal(context.teamBoard.entries.at(-1).text.split(":")[0], "39", "the newest notes are kept");
  assert.throws(() => buildContext({ ...base, teamBoard: { entries: "x" } }), { code: "invalid_field" });
});
