"use strict";

// Runs a team chat room. A user message opens a round; the host picks each
// next speaker (members in rotation, never the same agent twice in a row)
// and asks that agent's planner for one reply: say, pass or propose_task.
// A round ends at the turn cap, when every member passes in a row, when a
// task starts, or when the user stops it. One round per room at a time; a
// message posted mid-round is simply in the transcript the next speaker
// reads.
//
// propose_task starts an ordinary team task right away (the user chose
// auto-start), behind fixed guards: at most one task per round, at most one
// running task per room, and the task goes through startAgentTask, so the
// team's capability/MCP scope, the queue and the approver all apply as for a
// manual start. The room log keeps which user message opened the round, as
// the record that the task request was written by a model.
//
// Only one host runs a room's round at a time (the store's round lock), so
// two windows in local mode cannot both answer. A message that arrives while
// a round is running -- here or in another host -- is answered by a follow-up
// round once that round ends, unless it ended in a task start or a stop.
//
// recover(teamIds) rebuilds what memory lost on a restart from the log: the
// room's last started task is watched again (and reported at once if it
// settled meanwhile), and a lock left by a dead process is cleared with an
// "interrupted" notice.

const contracts = require("../../shared/room-contracts");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SETTLED = new Set(["completed", "stopped"]);
const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_FOLLOW_UPS = 3; // follow-up rounds in a row for waiting messages

// Stop must not wait for a worker that ignores the abort signal; its late
// reply is dropped.
function untilAborted(promise, signal) {
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(new RoomError("aborted", "round stopped"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([Promise.resolve(promise), aborted]).finally(() => signal.removeEventListener("abort", onAbort));
}

class RoomError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RoomError";
    this.code = code;
  }
}

class RoomOrchestrator {
  constructor({ store, getTeam, getAgent, requestTurn, startTask, getTaskState, emit, maxTurns = contracts.DEFAULT_MAX_TURNS } = {}) {
    for (const [name, value] of Object.entries({ getTeam, getAgent, requestTurn, startTask, getTaskState })) {
      if (typeof value !== "function") throw new RoomError("invalid_config", `${name} is required`);
    }
    if (!store) throw new RoomError("invalid_config", "store is required");
    if (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > contracts.MAX_TURNS) {
      throw new RoomError("invalid_config", `maxTurns must be an integer from 1 to ${contracts.MAX_TURNS}`);
    }
    this._store = store;
    this._getTeam = getTeam;
    this._getAgent = getAgent;
    this._requestTurn = requestTurn;
    this._startTask = startTask;
    this._getTaskState = getTaskState;
    this._emitFn = typeof emit === "function" ? emit : () => {};
    this._maxTurns = maxTurns;
    this._rounds = new Map(); // teamId -> { controller, promise, turn, speakerId }
    this._rotation = new Map(); // teamId -> index of the next member to ask
    this._roomTask = new Map(); // teamId -> taskId the room started
    this._taskRoom = new Map(); // taskId -> teamId, until its result is posted
  }

  async post(teamId, text) {
    if (typeof teamId !== "string" || !UUID_RE.test(teamId)) throw new RoomError("invalid_room", "room id must be a team UUID");
    if (typeof text !== "string" || !text.trim() || text.length > contracts.MAX_MESSAGE_CHARS) {
      throw new RoomError("invalid_message", `message must be 1..${contracts.MAX_MESSAGE_CHARS} characters`);
    }
    const team = await this._team(teamId);
    if (team.archived) throw new RoomError("agent_unavailable", "this team is archived");
    const message = await this._append(teamId, { author: "user", kind: "say", text });
    if (!this._rounds.has(teamId)) this._beginRound(teamId, message.messageId, 0);
    return message;
  }

  async stop(teamId) {
    const round = this._rounds.get(teamId);
    if (!round) return { stopped: false };
    round.controller.abort();
    await round.promise;
    await this._append(teamId, { author: "host", kind: "notice", text: "Round stopped." }).catch(() => {});
    return { stopped: true };
  }

  // Resolves once the room has no running round (tests and shutdown).
  async idle(teamId) {
    while (this._rounds.has(teamId)) await this._rounds.get(teamId).promise;
  }

  async close() {
    this._closed = true;
    const rounds = [...this._rounds.values()];
    for (const round of rounds) round.controller.abort();
    await Promise.allSettled(rounds.map((round) => round.promise));
  }

  getRoundState(teamId) {
    const round = this._rounds.get(teamId);
    return round ? { active: true, turn: round.turn, speakerId: round.speakerId } : { active: false, turn: 0, speakerId: null };
  }

  // Fed from TaskHost task events: posts a started task's outcome once.
  async onTaskEvent(taskId, snapshot) {
    const teamId = this._taskRoom.get(taskId);
    const state = snapshot?.state;
    if (!teamId || !SETTLED.has(state)) return;
    this._taskRoom.delete(taskId);
    const message = await this._store.append(teamId, { author: "host", kind: "notice", text: `The room's task ${state}.`, taskId }, { unlessTaskNotice: true }).catch(() => null);
    if (message) this._emit({ roomId: teamId, message });
  }

  // Rebuilds restart-lost state for these rooms from their logs. Safe to
  // call more than once and from several hosts over the same storage.
  async recover(teamIds) {
    for (const teamId of teamIds) {
      if (typeof teamId !== "string" || !UUID_RE.test(teamId)) continue;
      try {
        if (await this._store.clearStaleRoundLock(teamId)) {
          await this._append(teamId, { author: "host", kind: "notice", text: "The previous round was interrupted when HALO stopped." });
        }
        const pending = new Map();
        for (const message of await this._store.read(teamId)) {
          if (message.kind === "task_started" && message.taskId) pending.set(message.taskId, true);
          else if (message.kind === "notice" && message.taskId) pending.delete(message.taskId);
        }
        const taskId = [...pending.keys()].at(-1);
        if (!taskId || this._taskRoom.has(taskId)) continue;
        this._roomTask.set(teamId, taskId);
        this._taskRoom.set(taskId, teamId);
        const state = await Promise.resolve(this._getTaskState(taskId)).catch(() => null);
        if (SETTLED.has(state)) await this.onTaskEvent(taskId, { state });
      } catch {
        // One unreadable room never blocks the others.
      }
    }
  }

  async _team(teamId) {
    try {
      return await this._getTeam(teamId);
    } catch (error) {
      if (error?.code === "not_found" || error?.code === "invalid_id") throw new RoomError("invalid_room", "team does not exist");
      throw error;
    }
  }

  async _append(teamId, input) {
    const message = await this._store.append(teamId, input);
    this._emit({ roomId: teamId, message });
    return message;
  }

  _emit(event) {
    try { this._emitFn(event); } catch { /* an observer never affects the room */ }
  }

  _emitRound(teamId) {
    this._emit({ roomId: teamId, round: this.getRoundState(teamId) });
  }

  _beginRound(teamId, originMessageId, followUps) {
    const round = { controller: new AbortController(), promise: null, turn: 0, speakerId: null, lastSeenId: null, ended: "turns" };
    this._rounds.set(teamId, round);
    let lock = null;
    round.promise = (async () => {
      lock = await this._store.acquireRoundLock(teamId);
      if (!lock) {
        round.ended = "elsewhere"; // another host runs this room; it answers the waiting message
        return;
      }
      round.lock = lock;
      await this._runRound(teamId, originMessageId, round);
    })()
      .catch(async (error) => {
        round.ended = "error";
        if (!round.controller.signal.aborted) {
          await this._append(teamId, { author: "host", kind: "notice", text: `The round ended: ${error.message}`.slice(0, contracts.MAX_MESSAGE_CHARS) }).catch(() => {});
        }
      })
      .then(async () => {
        let waiting = round.ended === "turns" && !round.controller.signal.aborted
          ? await this._waitingMessage(teamId, round.lastSeenId).catch(() => null)
          : null;
        if (waiting && followUps >= MAX_FOLLOW_UPS) {
          // At the cap a late message would otherwise be left unanswered with
          // nothing scheduled: say so, and let the next message start a round.
          await this._append(teamId, { author: "host", kind: "notice", text: "Follow-up limit reached for now; send another message to continue." }).catch(() => {});
          waiting = null;
        }
        await Promise.resolve(lock?.release()).catch(() => {});
        return waiting;
      })
      .then((waiting) => {
        this._rounds.delete(teamId);
        if (waiting && !this._closed) this._beginRound(teamId, waiting.messageId, followUps + 1);
        else this._emitRound(teamId);
      });
    this._emitRound(teamId);
  }

  // A user message logged after the last transcript the round read.
  async _waitingMessage(teamId, lastSeenId) {
    const messages = await this._store.read(teamId);
    const from = lastSeenId ? messages.findIndex((m) => m.messageId === lastSeenId) + 1 : 0;
    return messages.slice(from).filter((m) => m.author === "user").at(-1) ?? null;
  }

  async _members(team) {
    const members = [];
    for (const id of team.memberAgentIds) {
      const agent = await Promise.resolve(this._getAgent(id)).catch(() => null);
      if (agent && !agent.archived) members.push(agent);
    }
    return members;
  }

  async _runRound(teamId, originMessageId, round) {
    const { signal } = round.controller;
    const team = await this._team(teamId);
    const members = await this._members(team);
    if (members.length === 0) {
      await this._append(teamId, { author: "host", kind: "notice", text: "No team member is available to reply." });
      return;
    }
    const maxTurns = members.length === 1 ? 1 : this._maxTurns;
    let previous = null;
    let passes = 0;
    const failures = new Set();
    let failedTurns = 0;
    while (round.turn < maxTurns && passes < members.length) {
      if (signal.aborted) return;
      let index = (this._rotation.get(teamId) ?? 0) % members.length;
      if (members.length > 1 && members[index].id === previous) index = (index + 1) % members.length;
      const speaker = members[index];
      this._rotation.set(teamId, (index + 1) % members.length);
      round.turn += 1;
      round.speakerId = speaker.id;
      this._emitRound(teamId);

      await Promise.resolve(round.lock?.refresh()).catch(() => {});
      const messages = await this._store.read(teamId);
      round.lastSeenId = messages.at(-1)?.messageId ?? null;
      const context = contracts.buildRoomTurnContext({ team, speaker, members, messages });
      let reply;
      let error = null;
      try {
        reply = contracts.validateRoomTurn(await untilAborted(this._requestTurn({ teamId, agent: speaker, context, signal }), signal));
      } catch (caught) {
        error = typeof caught?.code === "string" && CODE_RE.test(caught.code) ? caught.code : "turn_failed";
      }
      if (signal.aborted) return;
      previous = speaker.id;

      if (error) {
        failures.add(error);
        failedTurns += 1;
      }
      if (error || reply.kind === "pass") {
        passes += 1;
        await this._append(teamId, { author: speaker.id, kind: "pass", text: "", ...(error ? { error } : {}) });
        continue;
      }
      passes = 0;
      if (reply.kind === "say") {
        await this._append(teamId, { author: speaker.id, kind: "say", text: reply.text });
        continue;
      }
      await this._append(teamId, { author: speaker.id, kind: "propose_task", text: reply.request });
      if (await this._roomTaskRunning(teamId)) {
        await this._append(teamId, { author: "host", kind: "notice", text: "Not started: the room's task is already running." });
        continue;
      }
      try {
        const { taskId } = await this._startTask({ teamId, request: reply.request, originMessageId });
        this._roomTask.set(teamId, taskId);
        this._taskRoom.set(taskId, teamId);
        await this._append(teamId, { author: "host", kind: "task_started", text: reply.request, taskId, originMessageId });
      } catch (caught) {
        await this._append(teamId, { author: "host", kind: "notice", text: `Could not start the task: ${caught?.message ?? "unknown error"}`.slice(0, contracts.MAX_MESSAGE_CHARS) });
      }
      round.ended = "task";
      return; // at most one task per round, and a start (or a failed one) ends it
    }
    // Every turn failed: say so once rather than leaving silent passes.
    if (failedTurns > 0 && failedTurns === round.turn) {
      await this._append(teamId, { author: "host", kind: "notice", text: `Team members couldn't reply (${[...failures].join(", ")}). Their worker may not support team rooms.` });
    }
  }

  async _roomTaskRunning(teamId) {
    const taskId = this._roomTask.get(teamId);
    if (!taskId) return false;
    const state = await Promise.resolve(this._getTaskState(taskId)).catch(() => null);
    return state !== null && state !== undefined && !SETTLED.has(state);
  }
}

module.exports = { RoomOrchestrator, RoomError };
