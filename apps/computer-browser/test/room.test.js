"use strict";

// Team chat room: wire contract, append-only store, and the round
// orchestrator that lets team members talk and auto-start one task.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const contracts = require("../shared/room-contracts");
const { RoomStore } = require("../main/harness/room-store");
const { RoomOrchestrator } = require("../main/harness/room-orchestrator");

const TEAM = "11111111-1111-4111-8111-111111111111";
const A = "22222222-2222-4222-8222-222222222222";
const B = "33333333-3333-4333-8333-333333333333";
const C = "44444444-4444-4444-8444-444444444444";

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), "halo-room-"));

test("a room turn reply is exactly say, pass, or propose_task", () => {
  assert.deepEqual(contracts.validateRoomTurn({ kind: "say", text: "hi" }), { kind: "say", text: "hi" });
  assert.deepEqual(contracts.validateRoomTurn({ kind: "pass" }), { kind: "pass" });
  assert.deepEqual(contracts.validateRoomTurn({ kind: "propose_task", request: "book it" }), { kind: "propose_task", request: "book it" });
  for (const bad of [
    null, "say", { kind: "say" }, { kind: "say", text: "" }, { kind: "say", text: "   " },
    { kind: "say", text: "x".repeat(contracts.MAX_MESSAGE_CHARS + 1) }, { kind: "say", text: "hi", extra: 1 },
    { kind: "pass", text: "no" }, { kind: "propose_task", request: "x".repeat(contracts.MAX_TASK_REQUEST_CHARS + 1) },
    { kind: "actions", actions: [] },
  ]) {
    assert.throws(() => contracts.validateRoomTurn(bad), { code: "invalid_room_turn" }, JSON.stringify(bad));
  }
});

test("the turn context names the speaker, marks peers untrusted, and stays under the byte cap", () => {
  const team = { id: TEAM, name: "Trip" };
  const you = { id: A, name: "Ann", title: "Planner", instructions: "Be brief." };
  const members = [you, { id: B, name: "Bo", title: "", instructions: "secret B" }];
  const messages = Array.from({ length: 400 }, (_, i) => ({ messageId: `m${i}`, author: i % 2 ? A : "user", kind: "say", text: `${i} ${"y".repeat(200)}`, at: "2026-10-02T00:00:00.000Z" }));
  const context = contracts.buildRoomTurnContext({ team, speaker: you, members, messages });
  assert.equal(context.roomTurn.you.name, "Ann");
  assert.equal(context.roomTurn.you.instructions, "Be brief.");
  assert.deepEqual(context.roomTurn.members.map((m) => m.name), ["Ann", "Bo"]);
  assert.equal(JSON.stringify(context).includes("secret B"), false, "peers' instructions never reach another agent");
  assert.ok(Buffer.byteLength(JSON.stringify(context), "utf8") <= contracts.MAX_CONTEXT_BYTES);
  const last = context.roomTurn.transcript.at(-1);
  assert.match(last.text, /^399 /, "the newest messages are kept");
  assert.equal(last.authorName, "Ann");
  assert.equal(context.roomTurn.transcript.find((m) => m.author === "user").authorName, "User");
});

test("the store appends 0600 JSONL, keeps the newest messages, and fails closed", async () => {
  const root = await tmp();
  const store = new RoomStore({ storageRoot: root, now: () => Date.parse("2026-10-02T00:00:00Z") });
  const first = await store.append(TEAM, { author: "user", kind: "say", text: "hello" });
  assert.equal(first.roomId, TEAM);
  assert.match(first.messageId, /^[0-9a-f-]{36}$/);
  assert.equal(first.at, "2026-10-02T00:00:00.000Z");
  const file = path.join(root, "rooms", `${TEAM}.jsonl`);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(root, "rooms"))).mode & 0o777, 0o700);
  assert.deepEqual((await store.read(TEAM)).map((m) => m.text), ["hello"]);
  assert.deepEqual(await store.read("55555555-5555-4555-8555-555555555555"), []);
  await assert.rejects(store.append("../x", { author: "user", kind: "say", text: "x" }), { code: "invalid_room" });
  await assert.rejects(store.append(TEAM, { author: "user", kind: "say", text: "x".repeat(contracts.MAX_MESSAGE_CHARS + 1) }), { code: "invalid_message" });
  await assert.rejects(store.append(TEAM, { author: "user", kind: "shout", text: "x" }), { code: "invalid_message" });

  await fs.appendFile(file, "not json\n");
  await assert.rejects(store.read(TEAM), { code: "room_corrupt" });

  const linked = await tmp();
  await fs.mkdir(path.join(linked, "rooms"), { mode: 0o700 });
  await fs.symlink(file, path.join(linked, "rooms", `${TEAM}.jsonl`));
  await assert.rejects(new RoomStore({ storageRoot: linked }).read(TEAM), { code: "unsafe_path" });
});

test("the store returns at most the newest MAX_ROOM_MESSAGES", async () => {
  const store = new RoomStore({ storageRoot: await tmp() });
  for (let i = 0; i < contracts.MAX_ROOM_MESSAGES + 3; i += 1) await store.append(TEAM, { author: "user", kind: "say", text: String(i) });
  const messages = await store.read(TEAM);
  assert.equal(messages.length, contracts.MAX_ROOM_MESSAGES);
  assert.equal(messages[0].text, "3");
});

function harness({ replies = {}, members = [A, B, C], archived = false, startTask, taskState = () => "running", maxTurns, storageRoot } = {}) {
  const agents = { [A]: { id: A, name: "Ann", title: "", instructions: "", archived: false }, [B]: { id: B, name: "Bo", title: "", instructions: "", archived: false }, [C]: { id: C, name: "Cy", title: "", instructions: "", archived: false } };
  const calls = [];
  const started = [];
  const events = [];
  return (async () => {
    const store = new RoomStore({ storageRoot: storageRoot ?? await tmp() });
    const orchestrator = new RoomOrchestrator({
      store,
      getTeam: async (id) => { if (id !== TEAM) throw Object.assign(new Error("no"), { code: "not_found" }); return { id: TEAM, name: "Trip", memberAgentIds: members, archived }; },
      getAgent: async (id) => agents[id],
      requestTurn: async ({ agent, context }) => {
        calls.push(agent.id);
        const queue = replies[agent.id] ?? [];
        const next = queue.length ? queue.shift() : { kind: "pass" };
        if (next instanceof Error) throw next;
        return typeof next === "function" ? next(context) : next;
      },
      startTask: startTask ?? (async ({ request }) => { started.push(request); return { taskId: `task-${started.length}` }; }),
      getTaskState: async (taskId) => taskState(taskId),
      emit: (event) => events.push(event),
      ...(maxTurns ? { maxTurns } : {}),
    });
    return { store, orchestrator, calls, started, events };
  })();
}

test("a user message starts a round; members rotate and all passing ends it", async () => {
  const h = await harness({ replies: { [A]: [{ kind: "say", text: "I'd check flights" }] } });
  await h.orchestrator.post(TEAM, "Plan a trip");
  await h.orchestrator.idle(TEAM);
  assert.deepEqual(h.calls, [A, B, C, A]);
  const kinds = (await h.store.read(TEAM)).map((m) => `${m.author === "user" ? "user" : m.author === "host" ? "host" : m.author.slice(0, 1)}:${m.kind}`);
  assert.deepEqual(kinds, ["user:say", "2:say", "3:pass", "4:pass", "2:pass"]);
  assert.equal(h.orchestrator.getRoundState(TEAM).active, false);
  assert.ok(h.events.some((e) => e.roomId === TEAM && e.message?.text === "Plan a trip"));
  assert.ok(h.events.some((e) => e.roomId === TEAM && e.round?.active === false));
});

test("a round never exceeds the turn cap and never repeats the previous speaker", async () => {
  const talk = () => Array.from({ length: 20 }, () => ({ kind: "say", text: "more" }));
  const h = await harness({ replies: { [A]: talk(), [B]: talk(), [C]: talk() }, maxTurns: 5 });
  await h.orchestrator.post(TEAM, "go");
  await h.orchestrator.idle(TEAM);
  assert.equal(h.calls.length, 5);
  for (let i = 1; i < h.calls.length; i += 1) assert.notEqual(h.calls[i], h.calls[i - 1]);
  assert.throws(() => new RoomOrchestrator({ store: {}, getTeam() {}, getAgent() {}, requestTurn() {}, startTask() {}, getTaskState() {}, maxTurns: contracts.MAX_TURNS + 1 }), { code: "invalid_config" });
});

test("an invalid or failed reply counts as a pass and is recorded", async () => {
  const h = await harness({ replies: { [A]: [{ kind: "say" }], [B]: [Object.assign(new Error("boom"), { code: "timeout" })] } });
  await h.orchestrator.post(TEAM, "go");
  await h.orchestrator.idle(TEAM);
  const messages = await h.store.read(TEAM);
  const a = messages.find((m) => m.author === A);
  assert.equal(a.kind, "pass");
  assert.equal(a.error, "invalid_room_turn");
  assert.equal(messages.find((m) => m.author === B).error, "timeout");
});

test("propose_task auto-starts one team task, ends the round, and records its origin", async () => {
  const h = await harness({ replies: { [A]: [{ kind: "propose_task", request: "Search flights to Jeju" }], [B]: [{ kind: "propose_task", request: "second" }] } });
  const posted = await h.orchestrator.post(TEAM, "Plan a trip");
  await h.orchestrator.idle(TEAM);
  assert.deepEqual(h.started, ["Search flights to Jeju"]);
  assert.deepEqual(h.calls, [A], "the round ends once a task starts");
  const messages = await h.store.read(TEAM);
  const proposal = messages.find((m) => m.kind === "propose_task");
  assert.equal(proposal.author, A);
  const startedMsg = messages.find((m) => m.kind === "task_started");
  assert.equal(startedMsg.author, "host");
  assert.equal(startedMsg.taskId, "task-1");
  assert.equal(startedMsg.originMessageId, posted.messageId, "the task is traced to the user message that opened the round");
});

test("a second task is refused while the room's task is still running", async () => {
  const h = await harness({ replies: { [A]: [{ kind: "propose_task", request: "one" }, { kind: "propose_task", request: "two" }] } });
  await h.orchestrator.post(TEAM, "first");
  await h.orchestrator.idle(TEAM);
  await h.orchestrator.post(TEAM, "again");
  await h.orchestrator.idle(TEAM);
  assert.deepEqual(h.started, ["one"]);
  const notices = (await h.store.read(TEAM)).filter((m) => m.kind === "notice");
  assert.ok(notices.some((m) => /already running/.test(m.text)));
});

test("a failed task start is reported in the room instead of crashing the round", async () => {
  const h = await harness({
    replies: { [A]: [{ kind: "propose_task", request: "one" }] },
    startTask: async () => { throw Object.assign(new Error("member archived"), { code: "team_member_unavailable" }); },
  });
  await h.orchestrator.post(TEAM, "go");
  await h.orchestrator.idle(TEAM);
  const notice = (await h.store.read(TEAM)).find((m) => m.kind === "notice");
  assert.match(notice.text, /could not start/i);
  assert.equal(h.orchestrator.getRoundState(TEAM).active, false);
});

test("the room's task result comes back once as a notice", async () => {
  let state = "running";
  const h = await harness({ replies: { [A]: [{ kind: "propose_task", request: "one" }] }, taskState: () => state });
  await h.orchestrator.post(TEAM, "go");
  await h.orchestrator.idle(TEAM);
  state = "completed";
  await h.orchestrator.onTaskEvent("task-1", { state: "completed" });
  await h.orchestrator.onTaskEvent("task-1", { state: "completed" });
  await h.orchestrator.onTaskEvent("other", { state: "completed" });
  const done = (await h.store.read(TEAM)).filter((m) => m.kind === "notice" && m.taskId === "task-1");
  assert.equal(done.length, 1);
  assert.match(done[0].text, /completed/);
});

test("stop ends the active round and a message during a round is read by the next speaker", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const seen = [];
  const h = await harness({ replies: {
    [A]: [async () => { await gate; return { kind: "say", text: "thinking" }; }],
    [B]: [(context) => { seen.push(context.roomTurn.transcript.map((m) => m.text)); return { kind: "pass" }; }],
  } });
  await h.orchestrator.post(TEAM, "first");
  await h.orchestrator.post(TEAM, "also this");
  release();
  await h.orchestrator.idle(TEAM);
  assert.ok(seen[0].includes("also this"));

  let hold;
  const h2 = await harness({ replies: { [A]: [() => new Promise((resolve) => { hold = resolve; })] } });
  await h2.orchestrator.post(TEAM, "go");
  while (!hold) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(h2.orchestrator.getRoundState(TEAM).active, true);
  await h2.orchestrator.stop(TEAM);
  hold({ kind: "say", text: "late" });
  await h2.orchestrator.idle(TEAM);
  const messages = await h2.store.read(TEAM);
  assert.equal(messages.some((m) => m.text === "late"), false, "a reply after stop is dropped");
  assert.ok(messages.some((m) => m.kind === "notice" && /stopped/i.test(m.text)));
  assert.deepEqual(h2.calls, [A]);
});

test("posting is refused for an archived team or empty text", async () => {
  const archived = await harness({ archived: true });
  await assert.rejects(archived.orchestrator.post(TEAM, "hi"), { code: "agent_unavailable" });
  const h = await harness();
  await assert.rejects(h.orchestrator.post(TEAM, "  "), { code: "invalid_message" });
  await assert.rejects(h.orchestrator.post("not-a-team", "hi"), { code: "invalid_room" });
});

test("a one-member team speaks once per message", async () => {
  const h = await harness({ members: [A], replies: { [A]: [{ kind: "say", text: "a" }, { kind: "say", text: "b" }] } });
  await h.orchestrator.post(TEAM, "go");
  await h.orchestrator.idle(TEAM);
  assert.deepEqual(h.calls, [A]);
});

// ---- restart, multi-host and worker limits ----

const deadPid = () => new Promise((resolve) => {
  const child = require("node:child_process").spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  child.on("exit", () => resolve(child.pid));
});

test("after a restart, a task the room started still reports its result once", async () => {
  const root = await tmp();
  const first = await harness({ storageRoot: root, members: [A], replies: { [A]: [{ kind: "propose_task", request: "Book it" }] } });
  await first.orchestrator.post(TEAM, "go");
  await first.orchestrator.idle(TEAM);
  await first.orchestrator.close();

  // A fresh orchestrator (the app restarted) recovers the pending task from the log.
  const second = await harness({ storageRoot: root, members: [A] });
  await second.orchestrator.recover([TEAM]);
  await second.orchestrator.onTaskEvent("task-1", { state: "completed" });
  await second.orchestrator.onTaskEvent("task-1", { state: "completed" });
  let notices = (await second.store.read(TEAM)).filter((m) => m.kind === "notice" && m.taskId === "task-1");
  assert.equal(notices.length, 1);

  // A task that settled while the app was closed is reported during recovery, once.
  const root2 = await tmp();
  const a = await harness({ storageRoot: root2, members: [A], replies: { [A]: [{ kind: "propose_task", request: "Book it" }] } });
  await a.orchestrator.post(TEAM, "go");
  await a.orchestrator.idle(TEAM);
  const b = await harness({ storageRoot: root2, members: [A], taskState: () => "stopped" });
  const c = await harness({ storageRoot: root2, members: [A], taskState: () => "stopped" });
  await Promise.all([b.orchestrator.recover([TEAM]), c.orchestrator.recover([TEAM])]);
  notices = (await b.store.read(TEAM)).filter((m) => m.kind === "notice" && m.taskId === "task-1");
  assert.deepEqual(notices.map((m) => m.text), ["The room's task stopped."]);
});

test("a recovered room task still blocks a second room task while it runs", async () => {
  const root = await tmp();
  const first = await harness({ storageRoot: root, members: [A], replies: { [A]: [{ kind: "propose_task", request: "one" }] } });
  await first.orchestrator.post(TEAM, "go");
  await first.orchestrator.idle(TEAM);
  const second = await harness({ storageRoot: root, members: [A], replies: { [A]: [{ kind: "propose_task", request: "two" }] } });
  await second.orchestrator.recover([TEAM]);
  await second.orchestrator.post(TEAM, "again");
  await second.orchestrator.idle(TEAM);
  assert.deepEqual(second.started, []);
  assert.ok((await second.store.read(TEAM)).some((m) => /already running/.test(m.text)));
});

test("only one host runs a room's round; a waiting message is answered after it", async () => {
  const root = await tmp();
  let hold;
  const one = await harness({ storageRoot: root, members: [A], replies: { [A]: [() => new Promise((resolve) => { hold = resolve; })] } });
  const two = await harness({ storageRoot: root, members: [A] });
  await one.orchestrator.post(TEAM, "first");
  while (!hold) await new Promise((resolve) => setImmediate(resolve));
  await two.orchestrator.post(TEAM, "second, from another window");
  await two.orchestrator.idle(TEAM);
  assert.deepEqual(two.calls, [], "the other host does not start a round of its own");
  hold({ kind: "pass" });
  await one.orchestrator.idle(TEAM);
  // A's held turn never saw the second message, so one more round answers it.
  assert.deepEqual(one.calls, [A, A]);
  const users = (await one.store.read(TEAM)).filter((m) => m.author === "user").map((m) => m.text);
  assert.deepEqual(users, ["first", "second, from another window"]);
});

test("a round cut off by a crash is marked interrupted and its lock is reclaimed", async () => {
  const root = await tmp();
  const store = new RoomStore({ storageRoot: root });
  await store.append(TEAM, { author: "user", kind: "say", text: "hi" });
  const pid = await deadPid();
  await fs.writeFile(path.join(root, "rooms", `${TEAM}.lock`), JSON.stringify({ pid, owner: "gone", at: new Date().toISOString() }), { mode: 0o600 });
  const one = await harness({ storageRoot: root, members: [A] });
  const two = await harness({ storageRoot: root, members: [A] });
  await Promise.all([one.orchestrator.recover([TEAM]), two.orchestrator.recover([TEAM])]);
  const interrupted = (await one.store.read(TEAM)).filter((m) => m.kind === "notice" && /interrupted/i.test(m.text));
  assert.equal(interrupted.length, 1);
  await one.orchestrator.post(TEAM, "go");
  await one.orchestrator.idle(TEAM);
  assert.deepEqual(one.calls, [A]);
  await assert.rejects(fs.lstat(path.join(root, "rooms", `${TEAM}.lock`)), { code: "ENOENT" }, "the lock is released after the round");
});

test("a live lock held by another host is never taken over, a symlinked lock is refused", async () => {
  const root = await tmp();
  const store = new RoomStore({ storageRoot: root });
  await store.append(TEAM, { author: "user", kind: "say", text: "hi" });
  const lockPath = path.join(root, "rooms", `${TEAM}.lock`);
  await fs.writeFile(lockPath, JSON.stringify({ pid: process.pid, owner: "other-host", at: new Date().toISOString() }), { mode: 0o600 });
  assert.equal(await store.acquireRoundLock(TEAM), null);
  assert.equal(await store.clearStaleRoundLock(TEAM), false);
  await fs.rm(lockPath);
  await fs.symlink(path.join(root, "elsewhere"), lockPath);
  await assert.rejects(store.acquireRoundLock(TEAM), { code: "unsafe_path" });
});

test("a worker that cannot take room turns gets one notice instead of silent passes", async () => {
  const bad = Object.assign(new Error("not a room turn"), { code: "invalid_room_turn" });
  const h = await harness({ members: [A, B], replies: { [A]: [bad, bad], [B]: [bad, bad] } });
  await h.orchestrator.post(TEAM, "hi");
  await h.orchestrator.idle(TEAM);
  const notices = (await h.store.read(TEAM)).filter((m) => m.kind === "notice");
  assert.equal(notices.length, 1);
  assert.match(notices[0].text, /couldn't reply/i);
  assert.match(notices[0].text, /invalid_room_turn/);
});

test("a long log is read from its tail across chunk boundaries", async () => {
  const store = new RoomStore({ storageRoot: await tmp() });
  const appends = [];
  for (let i = 0; i < 620; i += 1) appends.push(store.append(TEAM, { author: "user", kind: "say", text: `${i}:${"é".repeat(900)}` }));
  await Promise.all(appends);
  const messages = await store.read(TEAM);
  assert.equal(messages.length, contracts.MAX_ROOM_MESSAGES);
  assert.deepEqual(messages.map((m) => Number(m.text.split(":")[0])), Array.from({ length: 500 }, (_, i) => i + 120));
});
