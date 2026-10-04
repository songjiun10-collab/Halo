"use strict";

// Team chat room wire contract. A room turn is one planner request whose
// context carries `roomTurn` instead of a browser observation; the worker
// answers with exactly one of three replies. Nothing here can act on a
// page: the only effect a reply can have is `propose_task`, which the host
// turns into an ordinary team task (same queue, approver and capability
// limits as a manual start).

const MAX_MESSAGE_CHARS = 2000;
const MAX_TASK_REQUEST_CHARS = 1000;
const MAX_ROOM_MESSAGES = 500;
const MAX_CONTEXT_BYTES = 32 * 1024;
const DEFAULT_MAX_TURNS = 6;
const MAX_TURNS = 12;
const MESSAGE_KINDS = Object.freeze(["say", "pass", "propose_task", "task_started", "notice"]);
const DISCUSSION_REVIEW_SIGNALS = Object.freeze(["ambiguity", "high_impact", "conflict", "missing_evidence", "low_confidence", "repeated_failure"]);
const MAX_DISCUSSION_REVIEW_SIGNALS = 3;

class RoomContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RoomContractError";
    this.code = code;
  }
}

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

function nonEmptyText(value, max) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

// Throws invalid_room_turn for anything but the three exact reply shapes.
function validateRoomTurn(reply) {
  const fail = (why) => { throw new RoomContractError("invalid_room_turn", `room turn reply ${why}`); };
  if (!isPlainObject(reply)) fail("must be an object");
  const keys = Object.keys(reply).sort().join(",");
  if (reply.kind === "pass") {
    if (keys !== "kind") fail("of kind pass takes no other field");
    return { kind: "pass" };
  }
  if (reply.kind === "say") {
    if (!["kind,text", "kind,reviewSignals,text"].includes(keys) || !nonEmptyText(reply.text, MAX_MESSAGE_CHARS)) fail(`of kind say needs text of 1..${MAX_MESSAGE_CHARS} characters`);
    if (reply.reviewSignals !== undefined && (!Array.isArray(reply.reviewSignals) || reply.reviewSignals.length < 1 ||
        reply.reviewSignals.length > MAX_DISCUSSION_REVIEW_SIGNALS || new Set(reply.reviewSignals).size !== reply.reviewSignals.length ||
        reply.reviewSignals.some((signal) => !DISCUSSION_REVIEW_SIGNALS.includes(signal)))) fail("of kind say has invalid reviewSignals");
    return { kind: "say", text: reply.text, ...(reply.reviewSignals ? { reviewSignals: [...reply.reviewSignals] } : {}) };
  }
  if (reply.kind === "propose_task") {
    if (keys !== "kind,request" || !nonEmptyText(reply.request, MAX_TASK_REQUEST_CHARS)) fail(`of kind propose_task needs request of 1..${MAX_TASK_REQUEST_CHARS} characters`);
    return { kind: "propose_task", request: reply.request };
  }
  return fail("kind must be say, pass or propose_task");
}

// The only data a speaking agent sees: its own profile, its teammates'
// names/titles (never their instructions), and the newest transcript that
// fits under MAX_CONTEXT_BYTES.
function buildRoomTurnContext({ team, speaker, members, messages, discussionReview }) {
  const names = new Map(members.map((member) => [member.id, member.name]));
  const authorName = (author) => (author === "user" ? "User" : author === "host" ? "HALO" : names.get(author) ?? "Former member");
  const context = {
    roomTurn: {
      version: 1,
      team: { name: team.name },
      you: { agentId: speaker.id, name: speaker.name, title: speaker.title ?? "", instructions: speaker.instructions ?? "" },
      members: members.map((member) => ({ agentId: member.id, name: member.name, title: member.title ?? "" })),
      transcript: [],
      ...(discussionReview && Array.isArray(discussionReview.reasons) && discussionReview.reasons.length > 0 ? {
        discussionReview: {
          authority: "halo_orchestrator",
          reasons: discussionReview.reasons.filter((signal) => DISCUSSION_REVIEW_SIGNALS.includes(signal)),
          remainingReviewers: Math.max(0, Math.min(members.length, Number.isInteger(discussionReview.remainingReviewers) ? discussionReview.remainingReviewers : members.length)),
        },
      } : {}),
    },
  };
  const base = Buffer.byteLength(JSON.stringify(context), "utf8");
  let budget = MAX_CONTEXT_BYTES - base;
  const kept = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.kind === "pass") continue;
    const entry = { author: message.author, authorName: authorName(message.author), kind: message.kind, text: message.text };
    const size = Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
    if (size > budget) break;
    budget -= size;
    kept.push(entry);
  }
  context.roomTurn.transcript = kept.reverse();
  return context;
}

module.exports = {
  MAX_MESSAGE_CHARS,
  MAX_TASK_REQUEST_CHARS,
  MAX_ROOM_MESSAGES,
  MAX_CONTEXT_BYTES,
  DEFAULT_MAX_TURNS,
  MAX_TURNS,
  MESSAGE_KINDS,
  DISCUSSION_REVIEW_SIGNALS,
  MAX_DISCUSSION_REVIEW_SIGNALS,
  RoomContractError,
  validateRoomTurn,
  buildRoomTurnContext,
};
