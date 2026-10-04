"use strict";

// TaskHost's team chat room surface: a posted message runs a round through
// each member's own planner (child role, room context), and propose_task
// starts an ordinary team task through startAgentTask.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { TaskHost } = require("../main/harness/task-host");

const hosts = new Set();
test.afterEach(async () => {
  const open = [...hosts];
  hosts.clear();
  await Promise.all(open.map((host) => host.close()));
});

function finishing(context) {
  return { taskId: context.taskId, goalVersion: context.goalVersion, basedOnObservationId: "obs", criterionIds: [], kind: "finish", evidenceIds: [] };
}

async function setup(roomReplies, { storageRoot: root, lifecycle = { made: 0, closed: 0 } } = {}) {
  const storageRoot = root ?? await fs.mkdtemp(path.join(os.tmpdir(), "halo-room-host-"));
  const plannerCalls = [];
  const host = new TaskHost({
    storageRoot,
    makeBrowser: () => ({ observe: async () => ({ id: "obs" }), execute: async () => ({ status: "ok" }) }),
    makePlanner: (id, options) => {
      if (id.startsWith("room-")) lifecycle.made += 1;
      return {
        next: async (context) => {
          if (!context.roomTurn) return finishing(context);
          plannerCalls.push({ id, role: options.role, speaker: context.roomTurn.you.name });
          return roomReplies.shift() ?? { kind: "pass" };
        },
        close: async () => { if (id.startsWith("room-")) lifecycle.closed += 1; },
      };
    },
    hostVerifier: () => true,
    approve: async () => ({ decision: "allow", reasons: [] }),
  });
  hosts.add(host);
  const avatar = { shape: "circle", color: "blue" };
  const ann = await host.saveAgent({ name: "Ann", avatar, capabilityId: "browser", instructions: "Plan trips." });
  const bo = await host.saveAgent({ name: "Bo", avatar, capabilityId: "browser" });
  const existing = (await host.listTeams()).find((t) => t.name === "Trip");
  const team = existing ?? await host.saveTeam({ name: "Trip", avatar, memberAgentIds: [ann.id, bo.id] });
  return { host, team, plannerCalls, storageRoot, lifecycle };
}

test("a posted message runs a round through each member's room planner", async () => {
  const { host, team, plannerCalls } = await setup([{ kind: "say", text: "Flights first." }]);
  const events = [];
  host.onRoomEvent((event) => events.push(event));
  const posted = await host.postRoomMessage({ teamId: team.id, text: "Plan Jeju" });
  assert.equal(posted.author, "user");
  await host._rooms.idle(team.id);
  assert.deepEqual(plannerCalls.map((c) => [c.role, c.speaker]), [["child", "Ann"], ["child", "Bo"], ["child", "Ann"]]);
  assert.ok(plannerCalls.every((c) => c.id === `room-${team.id}`));
  const room = await host.getRoom(team.id);
  assert.equal(room.roomId, team.id);
  assert.deepEqual(room.messages.map((m) => m.kind), ["say", "say", "pass", "pass"]);
  assert.deepEqual(room.round, { active: false, turn: 0, speakerId: null });
  assert.ok(events.some((e) => e.message?.text === "Flights first."));
  const rooms = await host.listRooms();
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].teamId, team.id);
  assert.equal(rooms[0].name, "Trip");
  assert.equal(rooms[0].lastMessage.kind, "pass");
  assert.equal(rooms[0].active, false);
});

test("propose_task starts a team task linked to the team's conversations", async () => {
  const { host, team } = await setup([{ kind: "propose_task", request: "Search flights to Jeju" }]);
  await host.postRoomMessage({ teamId: team.id, text: "Plan Jeju" });
  await host._rooms.idle(team.id);
  const started = (await host.getRoom(team.id)).messages.find((m) => m.kind === "task_started");
  assert.ok(started.taskId);
  const conversations = await host.listAgentConversations({ teamId: team.id });
  assert.deepEqual(conversations.map((c) => c.taskId), [started.taskId]);
  assert.equal(conversations[0].task.originalRequest, "Search flights to Jeju");
});

test("room inputs are exact and stop reports whether a round was running", async () => {
  const { host, team } = await setup([]);
  await assert.rejects(host.postRoomMessage({ teamId: team.id, text: "hi", extra: 1 }), { code: "invalid_message" });
  await assert.rejects(host.postRoomMessage(null), { code: "invalid_message" });
  await assert.rejects(host.getRoom("nope"), { code: "invalid_room" });
  assert.deepEqual(await host.stopRoomRound(team.id), { stopped: false });
});

test("a room keeps one planner across turns and closes it with the host", async () => {
  const { host, team, plannerCalls, lifecycle } = await setup([{ kind: "say", text: "a" }, { kind: "say", text: "b" }]);
  await host.postRoomMessage({ teamId: team.id, text: "go" });
  await host._rooms.idle(team.id);
  assert.ok(plannerCalls.length >= 3);
  assert.equal(lifecycle.made, 1);
  assert.equal(lifecycle.closed, 0);
  await host.close();
  assert.equal(lifecycle.closed, 1);
});

test("after a restart, the room reports the result of a task it started before", async () => {
  const first = await setup([{ kind: "propose_task", request: "Search flights to Jeju" }]);
  await first.host.postRoomMessage({ teamId: first.team.id, text: "Plan Jeju" });
  await first.host._rooms.idle(first.team.id);
  const started = (await first.host.getRoom(first.team.id)).messages.find((m) => m.kind === "task_started");
  await first.host.close();
  hosts.delete(first.host);

  const second = await setup([], { storageRoot: first.storageRoot });
  const room = await second.host.getRoom(second.team.id);
  // The task was paused by the shutdown; stopping it now reports back to the room.
  assert.equal(room.messages.filter((m) => m.kind === "notice" && m.taskId === started.taskId).length, 0);
  await second.host.resumeSavedTask(started.taskId);
  await second.host.stopTask(started.taskId);
  const deadline = Date.now() + 5000;
  let notice;
  while (!notice && Date.now() < deadline) {
    notice = (await second.host.getRoom(second.team.id)).messages.find((m) => m.kind === "notice" && m.taskId === started.taskId);
    if (!notice) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(notice?.text, "The room's task stopped.");
});
